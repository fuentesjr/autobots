#!/usr/bin/env bash
# scripts/install.sh — Autobots installer
#
# Installs the Autobots skill and agent roster into a target repo
# (repo-local) or into the current user's ~/.claude (global).
#
# Works two ways:
#   1. Local checkout: run this script from inside (or pointed at) a clone
#      of the autobots repo. Source files are copied from disk.
#   2. Remote pipe:    curl -fsSL <raw-url>/scripts/install.sh | bash
#      Source files are downloaded from the raw GitHub base for --ref.
#
# See docs/spec.md §10 (INS-1..INS-7) for the normative requirements this
# script implements, and docs/design.md "Installation Script" for rationale.

set -euo pipefail

# ---------------------------------------------------------------------------
# Embedded agent list (INS-4). This literal array is parsed by
# scripts/validate_package.go and MUST match the agent files exactly.
# ---------------------------------------------------------------------------
AGENTS=(
  planner
  coding-worker
  fast-coding-worker
  helper-worker
  forensic-analyst
  doc-reviewer
  reviewer
  qa-engineer
  edge-case-analyst
  advisor
)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
AUTOBOTS_REPO="${AUTOBOTS_REPO:-fuentesjr/autobots}"
DEFAULT_REF="main"

TARGET_REPO=""
GLOBAL=0
DRY_RUN=0
FORCE=0
REF="$DEFAULT_REF"

SCRIPT_NAME="$(basename "$0")"

# Counters for the summary
COUNT_CREATED=0
COUNT_UPDATED=0
COUNT_SKIPPED=0
COUNT_WOULD=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --target <repo>   Install into the given repository path (repo-local).
                     Defaults to the current directory.
  --global          Install for the current user under ~/.claude instead
                     of a repo-local .claude directory.
  --dry-run         Preview writes without applying them.
  --force           Overwrite existing files whose content differs.
  --ref <git-ref>   Git ref to install from when running remotely
                     (default: main). Ignored for local-checkout installs
                     unless the local source cannot be found, in which
                     case it is used to fetch from GitHub instead.
  -h, --help        Show this help message and exit.

Environment:
  AUTOBOTS_REPO     Override the GitHub "owner/repo" slug used for the
                     raw-content base URL (default: fuentesjr/autobots).

Examples:
  ./scripts/install.sh --target ~/code/my-repo
  ./scripts/install.sh --global
  curl -fsSL https://raw.githubusercontent.com/fuentesjr/autobots/main/scripts/install.sh \
    | bash -s -- --global --ref main
EOF
}

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'WARNING: %s\n' "$*" >&2
}

err() {
  printf 'ERROR: %s\n' "$*" >&2
}

die() {
  err "$*"
  exit 1
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die "--target requires an argument"
      TARGET_REPO="$2"
      shift 2
      ;;
    --target=*)
      TARGET_REPO="${1#--target=}"
      shift
      ;;
    --global)
      GLOBAL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires an argument"
      REF="$2"
      shift 2
      ;;
    --ref=*)
      REF="${1#--ref=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$GLOBAL" -eq 1 ] && [ -n "$TARGET_REPO" ]; then
  die "--global and --target are mutually exclusive"
fi

# ---------------------------------------------------------------------------
# INS-6: warn loudly if CLAUDE_CODE_SUBAGENT_MODEL is set, since it silently
# collapses per-role model routing onto a single model.
# ---------------------------------------------------------------------------
if [ -n "${CLAUDE_CODE_SUBAGENT_MODEL:-}" ]; then
  warn "CLAUDE_CODE_SUBAGENT_MODEL is set to '${CLAUDE_CODE_SUBAGENT_MODEL}'."
  warn "This silently overrides the per-role 'model:' frontmatter that Autobots ships,"
  warn "collapsing the entire agent roster onto a single model. Unset it if you want"
  warn "each Autobots role to run the model its spec declares."
fi

# ---------------------------------------------------------------------------
# Resolve destination root (INS-1, INS-2)
# ---------------------------------------------------------------------------
if [ "$GLOBAL" -eq 1 ]; then
  DEST_ROOT="${HOME}/.claude"
else
  if [ -n "$TARGET_REPO" ]; then
    DEST_ROOT="${TARGET_REPO%/}/.claude"
  else
    DEST_ROOT="$(pwd)/.claude"
  fi
fi

SKILL_DEST="${DEST_ROOT}/skills/autobots/SKILL.md"
AGENTS_DEST_DIR="${DEST_ROOT}/agents"

# ---------------------------------------------------------------------------
# Resolve source (INS-3): local checkout if the files are found next to this
# script / in the repo it lives in; otherwise fall back to the raw GitHub
# pipe using AUTOBOTS_REPO and --ref.
# ---------------------------------------------------------------------------

# Directory this script lives in (works for local execution; irrelevant,
# but harmless, when streamed via `curl | bash`, where $0 is "bash").
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || true)"
LOCAL_REPO_ROOT=""

if [ -n "$SCRIPT_DIR" ]; then
  CANDIDATE="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"
  if [ -n "$CANDIDATE" ] && [ -f "$CANDIDATE/.claude/skills/autobots/SKILL.md" ]; then
    LOCAL_REPO_ROOT="$CANDIDATE"
  fi
fi

RAW_BASE="https://raw.githubusercontent.com/${AUTOBOTS_REPO}/${REF}"

if [ -n "$LOCAL_REPO_ROOT" ]; then
  MODE="local"
  log "Installing from local checkout: $LOCAL_REPO_ROOT"
else
  MODE="remote"
  log "Local source not found; installing from ${RAW_BASE} (ref: ${REF})"
  command -v curl >/dev/null 2>&1 || die "curl is required for remote installs but was not found"
fi

log "Destination: ${DEST_ROOT} $( [ "$GLOBAL" -eq 1 ] && echo '(global)' || echo '(repo-local)' )"
[ "$DRY_RUN" -eq 1 ] && log "Dry run: no files will be written."

# ---------------------------------------------------------------------------
# Fetch helpers: produce the source content for a given relative path into a
# temp file, then hand off to install_file for the compare/write logic.
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/autobots-install.XXXXXX")"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fetch_to_tmp() {
  # $1: relative path (e.g. .claude/skills/autobots/SKILL.md)
  # prints path to a local temp copy of that file's content
  rel="$1"
  tmp_file="${TMP_DIR}/$(echo "$rel" | tr '/' '_')"

  if [ "$MODE" = "local" ]; then
    src="${LOCAL_REPO_ROOT}/${rel}"
    [ -f "$src" ] || die "Expected source file not found: $src"
    cp "$src" "$tmp_file"
  else
    url="${RAW_BASE}/${rel}"
    if ! curl -fsSL "$url" -o "$tmp_file"; then
      die "Failed to download $url"
    fi
  fi

  printf '%s' "$tmp_file"
}

# ---------------------------------------------------------------------------
# INS-5: install one file with safe-overwrite / dry-run semantics.
# ---------------------------------------------------------------------------
install_file() {
  # $1: source temp file, $2: destination path, $3: label for the summary
  src="$1"
  dest="$2"
  label="$3"

  if [ -f "$dest" ]; then
    if cmp -s "$src" "$dest"; then
      log "  [skip]      ${label} (unchanged)"
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$FORCE" -ne 1 ]; then
      warn "  [conflict]  ${label} exists and differs; use --force to overwrite (left untouched)"
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [would-update] ${label}"
      COUNT_WOULD=$((COUNT_WOULD + 1))
      return
    fi

    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    log "  [updated]   ${label}"
    COUNT_UPDATED=$((COUNT_UPDATED + 1))
    return
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [would-create] ${label}"
    COUNT_WOULD=$((COUNT_WOULD + 1))
    return
  fi

  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  log "  [created]   ${label}"
  COUNT_CREATED=$((COUNT_CREATED + 1))
}

# ---------------------------------------------------------------------------
# Install the skill (INS-2)
# ---------------------------------------------------------------------------
log ""
log "Skill:"
skill_src="$(fetch_to_tmp ".claude/skills/autobots/SKILL.md")"
install_file "$skill_src" "$SKILL_DEST" ".claude/skills/autobots/SKILL.md"

# ---------------------------------------------------------------------------
# Install each agent (INS-2, INS-4)
# ---------------------------------------------------------------------------
log ""
log "Agents:"
for agent in "${AGENTS[@]}"; do
  rel=".claude/agents/${agent}.md"
  agent_src="$(fetch_to_tmp "$rel")"
  install_file "$agent_src" "${AGENTS_DEST_DIR}/${agent}.md" "$rel"
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log ""
log "Summary: ${COUNT_CREATED} created, ${COUNT_UPDATED} updated, ${COUNT_SKIPPED} skipped, ${COUNT_WOULD} would-write (dry-run)"

if [ "$DRY_RUN" -eq 1 ]; then
  log ""
  log "Dry run complete. Re-run without --dry-run to apply these changes."
else
  # INS-7
  log ""
  log "Install complete. Start a new Claude Code session to pick up the agents:"
  log "  - Agent (.claude/agents) changes require a session restart, unless made via /agents."
  log "  - Skill (.claude/skills) changes are picked up live and need no restart."
fi
