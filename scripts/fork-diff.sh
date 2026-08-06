#!/usr/bin/env bash
# Compare shared dispatcher sections and agent roster against optimites.
# Run before editing either fork to detect drift (canonical: autobots).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPTIMITES="${OPTIMITES_ROOT:-$(cd "$ROOT/../optimites" 2>/dev/null && pwd || true)}"

if [[ -z "${OPTIMITES}" || ! -d "${OPTIMITES}" ]]; then
  echo "optimites checkout not found (set OPTIMITES_ROOT). Looked for sibling ../optimites" >&2
  exit 2
fi

echo "canonical: $ROOT"
echo "fork:      $OPTIMITES"
echo

# Shared SKL/ADV content lives in SKILL.md; compare role-agnostic sections by
# stripping runtime-specific tokens for a structural signal.
extract_shared() {
  # Drop frontmatter, then strip platform-specific tool/model tokens for rough compare
  sed -n '/^# /,$p' "$1" \
    | sed -E \
      -e 's/autobots/DISPATCHER/g' \
      -e 's/optimites/DISPATCHER/g' \
      -e 's/`?Agent`?/SPAWN_TOOL/g' \
      -e 's/`?spawn_subagent`?/SPAWN_TOOL/g' \
      -e 's/SendMessage/RESUME/g' \
      -e 's/resume_from/RESUME/g' \
      -e 's/CLAUDE_CODE_SUBAGENT_MODEL/MODEL_OVERRIDE/g' \
      -e 's/GROK_SUBAGENTS/MODEL_OVERRIDE/g' \
      -e 's/\.claude\/agents/\.RUNTIME\/agents/g' \
      -e 's/\.grok\/agents/\.RUNTIME\/agents/g'
}

tmpa=$(mktemp)
tmpb=$(mktemp)
trap 'rm -f "$tmpa" "$tmpb"' EXIT

extract_shared "$ROOT/.claude/skills/autobots/SKILL.md" >"$tmpa"
extract_shared "$OPTIMITES/.grok/skills/optimites/SKILL.md" >"$tmpb"

echo "=== SKILL.md shared-surface diff (normalized) ==="
if diff -u "$tmpa" "$tmpb"; then
  echo "(no structural SKILL.md drift after normalization)"
else
  echo "(drift above — review; platform-specific recipes may be intentional)"
fi

echo
echo "=== Agent roster names ==="
auto_agents=$(ls "$ROOT/.claude/agents"/*.md 2>/dev/null | xargs -n1 basename | sed 's/\.md$//' | sort)
opt_agents=$(ls "$OPTIMITES/.grok/agents"/*.md 2>/dev/null | xargs -n1 basename | sed 's/\.md$//' | sort)
echo "autobots:  $auto_agents"
echo "optimites: $opt_agents"
comm -23 <(echo "$auto_agents") <(echo "$opt_agents") | sed 's/^/only-autobots: /' || true
comm -13 <(echo "$auto_agents") <(echo "$opt_agents") | sed 's/^/only-optimites: /' || true

echo
echo "=== Per-agent description word counts (frontmatter description) ==="
for side in autobots optimites; do
  if [[ $side == autobots ]]; then dir="$ROOT/.claude/agents"; else dir="$OPTIMITES/.grok/agents"; fi
  echo "-- $side --"
  for f in "$dir"/*.md; do
    name=$(basename "$f" .md)
    # crude: words between description: and next top-level key or ---
    words=$(awk '/^description:/{p=1;next} p&&/^(name|model|effort|color|tools|disallowedTools|capabilityMode):/{exit} p&&/^---/{exit} p' "$f" | wc -w | tr -d ' ')
    printf '  %-24s %s\n' "$name" "$words"
  done
done

echo
echo "Done. Canonical fork is autobots; port intentional shared changes there first, then to optimites."
