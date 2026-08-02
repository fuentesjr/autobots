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
# See docs/spec.md §10 (INS-1..INS-8) for the normative requirements this
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
SYMLINK=0
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
  --symlink         Symlink instead of copy: the skill directory and each
                     agent file point at this checkout instead of being
                     copied. Local-checkout mode only (errors in remote
                     curl-pipe installs, since there is no checkout on disk
                     to link to).
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
  ./scripts/install.sh --global --symlink
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
# canon_path: resolve a path (which may not fully exist yet) to its physical,
# symlink-resolved absolute form. Walks up to the nearest existing ancestor,
# resolves that ancestor with `cd ... && pwd -P`, and reattaches whatever
# non-existent suffix remains unresolved (there is nothing to resolve there
# yet). Used by the --symlink self-reference guard below so alternate
# spellings of the same physical destination (relative paths, trailing
# slashes, a --target that happens to point at the checkout itself) are all
# caught, not just an exact string match on the unresolved path.
# ---------------------------------------------------------------------------
# Contract: directory-only for the existing-path case — resolution is
# cd-based, so an existing *file* argument fails the cd and yields "".
# Callers holding a file path must canonicalize its parent and reattach
# the leaf themselves (see install_symlink).
canon_path() {
  cp_path="$1"
  cp_suffix=""
  while [ ! -e "$cp_path" ] && [ "$cp_path" != "/" ] && [ -n "$cp_path" ]; do
    cp_suffix="/$(basename "$cp_path")${cp_suffix}"
    cp_path="$(dirname "$cp_path")"
  done
  if [ -e "$cp_path" ]; then
    cp_path="$(cd "$cp_path" >/dev/null 2>&1 && pwd -P)"
  fi
  printf '%s%s\n' "$cp_path" "$cp_suffix"
}

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || die "--target requires an argument"
      TARGET_REPO="$2"
      [ -n "$TARGET_REPO" ] || die "--target requires a non-empty argument"
      shift 2
      ;;
    --target=*)
      TARGET_REPO="${1#--target=}"
      [ -n "$TARGET_REPO" ] || die "--target requires a non-empty argument"
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
    --symlink)
      SYMLINK=1
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

# Locate a source checkout next to this script. Only attempt this when the
# script actually exists on disk: when streamed via `curl | bash`, $0 is
# "bash", dirname resolves to the CWD, and the CWD's *parent* may hold an
# installed Autobots payload (a previously installed target repo, or $HOME
# with a --global install under ~/.claude) that must not be mistaken for a
# source checkout — that mistake would silently reinstall the already
# installed files onto themselves and ignore --ref.
SCRIPT_SOURCE="${BASH_SOURCE[0]:-$0}"
LOCAL_REPO_ROOT=""

if [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd || true)"
  if [ -n "$SCRIPT_DIR" ]; then
    CANDIDATE="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd || true)"
    # A source checkout carries the installer and spec alongside the payload;
    # an install destination carries the payload alone.
    if [ -n "$CANDIDATE" ] \
      && [ -f "$CANDIDATE/.claude/skills/autobots/SKILL.md" ] \
      && [ -f "$CANDIDATE/scripts/install.sh" ] \
      && [ -f "$CANDIDATE/docs/spec.md" ]; then
      LOCAL_REPO_ROOT="$CANDIDATE"
    fi
  fi
fi

RAW_BASE="https://raw.githubusercontent.com/${AUTOBOTS_REPO}/${REF}"

if [ -n "$LOCAL_REPO_ROOT" ]; then
  MODE="local"
  log "Installing from local checkout: $LOCAL_REPO_ROOT"
else
  MODE="remote"
  # --symlink requires real files on disk to point at, so it only makes
  # sense against a local checkout (INS-8). Check before logging the remote
  # fetch plan or touching the network.
  if [ "$SYMLINK" -eq 1 ]; then
    die "--symlink requires a local checkout (no on-disk source to link to in a remote install). Clone the repo first: git clone https://github.com/${AUTOBOTS_REPO}.git && cd \$(basename ${AUTOBOTS_REPO}) && ./scripts/install.sh --symlink ..."
  fi
  log "Local source not found; installing from ${RAW_BASE} (ref: ${REF})"
  command -v curl >/dev/null 2>&1 || die "curl is required for remote installs but was not found"
fi

# --symlink self-reference guard (blocker): if DEST_ROOT resolves to the
# checkout's own .claude, --force would `rm -rf` the SOURCE checkout and
# leave a self-referential dangling symlink while reporting success,
# destroying uncommitted/untracked work. Canonicalize both sides so
# alternate spellings via --target (relative paths, trailing slashes,
# --target pointing at the checkout itself) are caught, not just an exact
# string match. install_symlink repeats this check per entry as defense in
# depth. This never fires for the intended `--global` case, since ~/.claude
# is a different physical path from the checkout's .claude.
if [ "$SYMLINK" -eq 1 ] && [ "$MODE" = "local" ]; then
  dest_root_canon="$(canon_path "$DEST_ROOT")"
  checkout_claude_canon="$(canon_path "${LOCAL_REPO_ROOT}/.claude")"
  if [ "$dest_root_canon" = "$checkout_claude_canon" ]; then
    die "cannot symlink a checkout onto itself: --symlink destination (${DEST_ROOT}) resolves to the checkout's own .claude (${LOCAL_REPO_ROOT}/.claude). Point --target/--global at a different destination."
  fi
fi

log "Destination: ${DEST_ROOT} $( [ "$GLOBAL" -eq 1 ] && echo '(global)' || echo '(repo-local)' )"
[ "$SYMLINK" -eq 1 ] && log "Mode: symlink (linking to the checkout instead of copying)"
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
  dest_dir="$(dirname "$dest")"

  # A symlink at dest, or at dest's immediate parent directory (the skill's
  # directory-level link from a prior --symlink install), must never be
  # treated as a plain file: `cp` follows a live symlink and writes THROUGH
  # it into whatever it points at — silently corrupting the linked-to
  # checkout instead of updating this destination — and `-L` (unlike `-e`
  # or `-f`) is true even for a dangling link, so a moved/deleted checkout's
  # broken links are caught too instead of failing `mkdir -p` with a raw
  # "File exists" error. Treat either shape as its own conflict class and
  # always remove the link itself before writing, so a forced copy lands as
  # a real file/directory at this destination, decoupled from the source.
  if [ -L "$dest" ] || [ -L "$dest_dir" ]; then
    symlink_at="$dest"
    [ -L "$dest" ] || symlink_at="$dest_dir"

    if [ "$FORCE" -ne 1 ]; then
      warn "  [conflict]  ${label} is reached through a symlink (${symlink_at}, from a prior --symlink install); use --force to replace with a real copy (left untouched)"
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [would-update] ${label} (replacing symlink with a real copy)"
      COUNT_WOULD=$((COUNT_WOULD + 1))
      return
    fi

    rm -f "$symlink_at"
    mkdir -p "$dest_dir"
    cp "$src" "$dest"
    log "  [updated]   ${label} (replaced symlink with a real copy)"
    COUNT_UPDATED=$((COUNT_UPDATED + 1))
    return
  fi

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

    mkdir -p "$dest_dir"
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

  mkdir -p "$dest_dir"
  cp "$src" "$dest"
  log "  [created]   ${label}"
  COUNT_CREATED=$((COUNT_CREATED + 1))
}

# ---------------------------------------------------------------------------
# --symlink (INS-8): link one destination path at an absolute target instead
# of copying. Used for both the skill directory symlink and the per-agent
# file symlinks.
#
# Guards, checked before any write:
#   - target does not exist on disk            -> die (same message shape as
#     fetch_to_tmp's missing-source die)
#   - dest and target canonicalize to the same physical path (blocker) ->
#     die "cannot symlink a checkout onto itself" — this is defense in depth
#     on top of the upfront DEST_ROOT check; --force's rm below would
#     otherwise delete the SOURCE and leave a self-referential dangling link
#     while reporting success
#
# Safety semantics mirror install_file's (INS-5), extended for symlinks:
#   - dest already a symlink to $target        -> [skip] (unchanged)
#   - dest is a symlink to a different target,
#     without --force                          -> [conflict], left untouched
#   - dest is a symlink to a different target,
#     with --force                             -> [relinked] (the old link
#     itself is removed, not recursed into — it's just a symlink)
#   - dest is a real file/dir, without --force  -> [conflict], left
#     untouched; the warning names the consequence when dest is a real
#     directory, since --force deletes it and its contents recursively
#   - dest is a real file/dir, with --force     -> [replaced] (rm -rf then
#     ln -s, so a real directory can't swallow the new symlink as a nested
#     entry)
#   - dest does not exist                      -> [linked]
#   - --dry-run                                -> preview only, no writes;
#     labeled [would-relink] (benign: replacing another symlink) vs
#     [would-replace] (destructive when dest is a real directory) so the
#     preview distinguishes the two before the user commits to --force
# ---------------------------------------------------------------------------
install_symlink() {
  # $1: absolute symlink target, $2: destination path, $3: label for the summary
  target="$1"
  dest="$2"
  label="$3"

  if [ ! -e "$target" ]; then
    die "Expected source file not found: $target"
  fi

  # Compare physical locations, not the destination's *current* resolution:
  # if dest is already a symlink (e.g. this entry was correctly linked on a
  # prior run), canon_path on dest itself would follow that link and always
  # equal the target — a false "self-reference" on every legitimate re-run.
  # Resolve dest's parent directory only and reattach dest's own leaf name
  # unresolved, so this catches the real hazard (the leaf's parent directory
  # physically *is* the target, e.g. from inside the checkout with no
  # --target) without tripping on a leaf that is itself a correct symlink.
  # Both sides resolve parent-then-leaf: canon_path is cd-based and returns
  # "" for an existing file, so canonicalizing a file target directly would
  # leave this guard inert for every agent entry. Parent resolution also
  # catches a destination agents/ directory that is itself a symlink into
  # the checkout — the parent resolves through it to the checkout's own dir.
  target_parent_canon="$(canon_path "$(dirname "$target")")"
  target_canon="${target_parent_canon}/$(basename "$target")"
  dest_parent_canon="$(canon_path "$(dirname "$dest")")"
  dest_canon="${dest_parent_canon}/$(basename "$dest")"
  if [ "$target_canon" = "$dest_canon" ]; then
    die "cannot symlink a checkout onto itself: ${label} destination and target both resolve to ${target_canon}."
  fi

  if [ -L "$dest" ]; then
    current_target="$(readlink "$dest")"
    if [ "$current_target" = "$target" ]; then
      log "  [skip]      ${label} (unchanged)"
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$FORCE" -ne 1 ]; then
      warn "  [conflict]  ${label} is a symlink to a different target; use --force to relink (left untouched)"
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [would-relink] ${label}"
      COUNT_WOULD=$((COUNT_WOULD + 1))
      return
    fi

    rm -f "$dest"
    mkdir -p "$(dirname "$dest")"
    ln -s "$target" "$dest"
    log "  [relinked]  ${label}"
    COUNT_UPDATED=$((COUNT_UPDATED + 1))
    return
  fi

  if [ -e "$dest" ]; then
    if [ "$FORCE" -ne 1 ]; then
      if [ -d "$dest" ]; then
        warn "  [conflict]  ${label} exists and is not a symlink; --force will delete it and its contents to replace it (left untouched)"
      else
        warn "  [conflict]  ${label} exists and is not a symlink; use --force to replace (left untouched)"
      fi
      COUNT_SKIPPED=$((COUNT_SKIPPED + 1))
      return
    fi

    if [ "$DRY_RUN" -eq 1 ]; then
      if [ -d "$dest" ]; then
        log "  [would-replace] ${label} (--force will delete it and its contents)"
      else
        log "  [would-replace] ${label}"
      fi
      COUNT_WOULD=$((COUNT_WOULD + 1))
      return
    fi

    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    ln -s "$target" "$dest"
    log "  [replaced]  ${label}"
    COUNT_UPDATED=$((COUNT_UPDATED + 1))
    return
  fi

  # Destination does not exist yet: create the symlink.
  if [ "$DRY_RUN" -eq 1 ]; then
    log "  [would-link] ${label}"
    COUNT_WOULD=$((COUNT_WOULD + 1))
    return
  fi
  mkdir -p "$(dirname "$dest")"
  ln -s "$target" "$dest"
  log "  [linked]    ${label}"
  COUNT_CREATED=$((COUNT_CREATED + 1))
}

# ---------------------------------------------------------------------------
# Install the skill (INS-2, INS-8)
# ---------------------------------------------------------------------------
log ""
log "Skill:"
if [ "$SYMLINK" -eq 1 ]; then
  skill_target="${LOCAL_REPO_ROOT}/.claude/skills/autobots"
  install_symlink "$skill_target" "${DEST_ROOT}/skills/autobots" ".claude/skills/autobots"
else
  skill_src="$(fetch_to_tmp ".claude/skills/autobots/SKILL.md")"
  install_file "$skill_src" "$SKILL_DEST" ".claude/skills/autobots/SKILL.md"
fi

# ---------------------------------------------------------------------------
# Install each agent (INS-2, INS-4, INS-8)
# ---------------------------------------------------------------------------
log ""
log "Agents:"
for agent in "${AGENTS[@]}"; do
  rel=".claude/agents/${agent}.md"
  if [ "$SYMLINK" -eq 1 ]; then
    install_symlink "${LOCAL_REPO_ROOT}/${rel}" "${AGENTS_DEST_DIR}/${agent}.md" "$rel"
  else
    agent_src="$(fetch_to_tmp "$rel")"
    install_file "$agent_src" "${AGENTS_DEST_DIR}/${agent}.md" "$rel"
  fi
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
