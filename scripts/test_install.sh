#!/usr/bin/env bash
# scripts/test_install.sh — executable test harness for scripts/install.sh
#
# Plain bash, no framework: mktemp -d fixtures, assert-with-message
# functions, sequential test_* functions run from main() at the bottom.
# Portable to macOS bash 3.2 and Linux (CI runs ubuntu-latest).
#
# Every test installs from a *copy* of this repo's payload
# (new_checkout/new_target below) into throwaway targets under one
# mktemp -d sandbox; nothing here may write outside that sandbox. HOME is
# also pointed at a sandbox dir for the whole process, belt-and-braces,
# in case a regression ever reaches a --global code path.
#
# See docs/spec.md INS-8 for the --symlink contract this harness checks,
# and implementation-notes.md for the review history that motivated it.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." >/dev/null 2>&1 && pwd)"

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/autobots-install-test.XXXXXX")"
# Normalize away a trailing slash a platform's $TMPDIR may carry (macOS does):
# install.sh resolves its own paths through `cd ... && pwd`, which collapses
# double slashes, so an un-normalized TEST_ROOT would make every expected
# symlink-target string in this file a false mismatch against install.sh's
# real (normalized) output.
TEST_ROOT="$(cd "$TEST_ROOT" && pwd)"
export HOME="${TEST_ROOT}/home"
mkdir -p "$HOME"

# shellcheck disable=SC2329 # invoked via `trap cleanup EXIT` below, not a
# direct call; shellcheck's reachability check doesn't see through trap once
# main()'s call graph is present.
cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

STDOUT_FILE="${TEST_ROOT}/_stdout"
STDERR_FILE="${TEST_ROOT}/_stderr"

TESTS_RUN=0
TESTS_FAILED=0
FAILURES=()

# ---------------------------------------------------------------------------
# Assertion helpers
# ---------------------------------------------------------------------------

pass() {
  TESTS_RUN=$((TESTS_RUN + 1))
  printf '  ok   - %s\n' "$1"
}

fail() {
  TESTS_RUN=$((TESTS_RUN + 1))
  TESTS_FAILED=$((TESTS_FAILED + 1))
  printf '  FAIL - %s\n' "$1" >&2
  FAILURES+=("$1")
}

assert_eq() { # actual expected msg
  if [ "$1" = "$2" ]; then
    pass "$3"
  else
    fail "$3 (expected [$2], got [$1])"
  fi
}

assert_contains() { # haystack needle msg
  case "$1" in
    *"$2"*) pass "$3" ;;
    *) fail "$3 (expected output to contain [$2]; got: $1)" ;;
  esac
}

assert_not_contains() { # haystack needle msg
  case "$1" in
    *"$2"*) fail "$3 (expected output NOT to contain [$2]; got: $1)" ;;
    *) pass "$3" ;;
  esac
}

assert_file() { # path msg
  if [ -f "$1" ]; then
    pass "$2"
  else
    fail "$2 (no such file: $1)"
  fi
}

assert_path_missing() { # path msg
  if [ -e "$1" ] || [ -L "$1" ]; then
    fail "$2 (unexpectedly exists: $1)"
  else
    pass "$2"
  fi
}

assert_not_symlink() { # path msg
  if [ -L "$1" ]; then
    fail "$2 ($1 is unexpectedly a symlink -> $(readlink "$1"))"
  else
    pass "$2"
  fi
}

assert_symlink_to() { # path expected_target msg
  if [ ! -L "$1" ]; then
    fail "$3 ($1 is not a symlink)"
    return
  fi
  assert_eq "$(readlink "$1")" "$2" "$3"
}

assert_content_matches() { # actual_file expected_file msg
  if cmp -s "$1" "$2"; then
    pass "$3"
  else
    fail "$3 ($1 does not match $2)"
  fi
}

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

# Copies this repo's tracked payload into a fresh sandbox dir and returns
# its path. Every test that runs install.sh runs it from one of these
# copies, never from $REPO_ROOT itself.
new_checkout() {
  local dest entry base
  dest="$(mktemp -d "${TEST_ROOT}/checkout.XXXXXX")"
  # Copy top-level entries individually (skipping .git/.trk) rather than
  # `cp -R repo/. dest/`, so .git's fsmonitor socket is never touched (cp
  # can't copy a socket and warns loudly, which is harmless but noisy).
  for entry in "${REPO_ROOT}"/* "${REPO_ROOT}"/.[!.]*; do
    [ -e "$entry" ] || continue
    base="$(basename "$entry")"
    case "$base" in
      .git | .trk) continue ;;
    esac
    cp -R "$entry" "${dest}/${base}"
  done
  printf '%s' "$dest"
}

# A fresh, empty directory to use as --target (or as the sibling directory
# whose .claude is inspected). install.sh creates .claude/... under it.
new_target() {
  mktemp -d "${TEST_ROOT}/target.XXXXXX"
}

# Runs `bash "$@"`, capturing stdout/stderr/exit code without using set -e
# (several tests expect a nonzero exit).
run_install() {
  bash "$@" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  RUN_EXIT=$?
  RUN_STDOUT="$(cat "$STDOUT_FILE")"
  RUN_STDERR="$(cat "$STDERR_FILE")"
}

# Number of entries a full install writes: one skill dir/file plus one file
# per agent. Derived from the checkout's own agent roster rather than
# hardcoded, so the harness doesn't need editing when the roster changes.
AGENT_COUNT="$(find "${REPO_ROOT}/.claude/agents" -maxdepth 1 -type f -name '*.md' | wc -l)"
AGENT_COUNT="${AGENT_COUNT// /}"
TOTAL_ENTRIES=$((AGENT_COUNT + 1))

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

test_fresh_copy_install() {
  printf '\n== fresh copy install ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"

  run_install "${checkout}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "0" "fresh copy install exits 0"
  assert_contains "$RUN_STDOUT" "Summary: ${TOTAL_ENTRIES} created, 0 updated, 0 skipped, 0 would-write" \
    "summary: all ${TOTAL_ENTRIES} entries created"
  assert_file "${target}/.claude/skills/autobots/SKILL.md" "skill file created"
  assert_not_symlink "${target}/.claude/skills/autobots/SKILL.md" "skill file is a real file"
  assert_not_symlink "${target}/.claude/agents/planner.md" "agent file is a real file"
  assert_content_matches "${target}/.claude/agents/planner.md" "${checkout}/.claude/agents/planner.md" \
    "installed agent content matches source"
}

test_copy_reinstall_idempotent() {
  printf '\n== copy re-run idempotent ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"

  run_install "${checkout}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "0" "first copy install exits 0"
  run_install "${checkout}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "0" "second copy install exits 0"
  assert_contains "$RUN_STDOUT" "Summary: 0 created, 0 updated, ${TOTAL_ENTRIES} skipped, 0 would-write" \
    "re-run: everything skipped as unchanged"
}

test_fresh_symlink_install() {
  printf '\n== fresh --symlink install ==\n'
  local checkout target link
  checkout="$(new_checkout)"
  target="$(new_target)"

  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "fresh symlink install exits 0"
  assert_contains "$RUN_STDOUT" "Summary: ${TOTAL_ENTRIES} created, 0 updated, 0 skipped, 0 would-write" \
    "summary: all ${TOTAL_ENTRIES} entries linked"
  assert_symlink_to "${target}/.claude/skills/autobots" "${checkout}/.claude/skills/autobots" \
    "skill dir symlinks to the checkout"
  assert_symlink_to "${target}/.claude/agents/planner.md" "${checkout}/.claude/agents/planner.md" \
    "planner.md symlinks to the checkout"
  assert_symlink_to "${target}/.claude/agents/advisor.md" "${checkout}/.claude/agents/advisor.md" \
    "advisor.md symlinks to the checkout"

  link="$(readlink "${target}/.claude/agents/planner.md")"
  case "$link" in
    /*) pass "symlink target is an absolute path" ;;
    *) fail "symlink target is an absolute path (got: $link)" ;;
  esac
}

test_symlink_reinstall_all_skip() {
  printf '\n== --symlink re-run all-skip (a guard bug once broke this) ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"

  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "first symlink install exits 0"
  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "symlink re-run exits 0 (must not false-positive as self-referential)"
  assert_contains "$RUN_STDOUT" "Summary: 0 created, 0 updated, ${TOTAL_ENTRIES} skipped, 0 would-write" \
    "re-run: everything skipped as unchanged"
}

test_copy_conflict_without_force() {
  printf '\n== copy conflict without --force leaves dest untouched ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"
  mkdir -p "${target}/.claude/agents"
  printf 'pre-existing content\n' >"${target}/.claude/agents/planner.md"

  run_install "${checkout}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "0" "copy install with one conflict still exits 0"
  assert_contains "$RUN_STDERR" "conflict" "conflicting entry reported"
  assert_eq "$(cat "${target}/.claude/agents/planner.md")" "pre-existing content" \
    "conflicting file left untouched without --force"
  assert_file "${target}/.claude/agents/advisor.md" "non-conflicting entries still installed"
}

test_copy_force_overwrites() {
  printf '\n== copy --force overwrites a conflicting file ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"
  mkdir -p "${target}/.claude/agents"
  printf 'stale content\n' >"${target}/.claude/agents/planner.md"

  run_install "${checkout}/scripts/install.sh" --target "$target" --force
  assert_eq "$RUN_EXIT" "0" "copy --force install exits 0"
  assert_content_matches "${target}/.claude/agents/planner.md" "${checkout}/.claude/agents/planner.md" \
    "--force overwrote the conflicting file with source content"
}

test_symlink_conflict_real_file_without_force() {
  printf '\n== symlink install: real-file conflict without --force ==\n'
  local checkout target
  checkout="$(new_checkout)"
  target="$(new_target)"
  mkdir -p "${target}/.claude/agents"
  printf 'a real file, not a symlink\n' >"${target}/.claude/agents/planner.md"

  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "symlink install over one real-file conflict still exits 0"
  assert_contains "$RUN_STDERR" "conflict" "real-file conflict reported"
  assert_not_symlink "${target}/.claude/agents/planner.md" "conflicting real file left as-is, not replaced with a symlink"
  assert_eq "$(cat "${target}/.claude/agents/planner.md")" "a real file, not a symlink" \
    "conflicting real file content untouched"
  assert_symlink_to "${target}/.claude/agents/advisor.md" "${checkout}/.claude/agents/advisor.md" \
    "non-conflicting entries still symlinked"
}

test_symlink_force_relink() {
  printf '\n== symlink --force relinks to the correct target ==\n'
  local checkout1 checkout2 target
  checkout1="$(new_checkout)"
  checkout2="$(new_checkout)"
  target="$(new_target)"

  run_install "${checkout1}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "initial symlink install from checkout1 exits 0"

  run_install "${checkout2}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "symlink install from checkout2 without --force still exits 0 (conflicts)"
  assert_contains "$RUN_STDERR" "conflict" "symlink-to-different-target without --force reports a conflict"
  assert_symlink_to "${target}/.claude/agents/planner.md" "${checkout1}/.claude/agents/planner.md" \
    "without --force: still linked to checkout1"

  run_install "${checkout2}/scripts/install.sh" --target "$target" --symlink --force
  assert_eq "$RUN_EXIT" "0" "symlink --force relink exits 0"
  assert_symlink_to "${target}/.claude/agents/planner.md" "${checkout2}/.claude/agents/planner.md" \
    "with --force: relinked to checkout2"
}

test_dry_run_writes_nothing() {
  printf '\n== --dry-run writes nothing (copy and symlink) ==\n'
  local checkout target

  checkout="$(new_checkout)"
  target="$(new_target)"
  run_install "${checkout}/scripts/install.sh" --target "$target" --dry-run
  assert_eq "$RUN_EXIT" "0" "copy dry-run exits 0"
  assert_contains "$RUN_STDOUT" "Summary: 0 created, 0 updated, 0 skipped, ${TOTAL_ENTRIES} would-write" \
    "copy dry-run summary: all would-write"
  assert_path_missing "${target}/.claude" "copy dry-run created no .claude directory"

  target="$(new_target)"
  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink --dry-run
  assert_eq "$RUN_EXIT" "0" "symlink dry-run exits 0"
  assert_contains "$RUN_STDOUT" "Summary: 0 created, 0 updated, 0 skipped, ${TOTAL_ENTRIES} would-write" \
    "symlink dry-run summary: all would-write"
  assert_path_missing "${target}/.claude" "symlink dry-run created no .claude directory"
}

test_remote_symlink_rejection() {
  printf '\n== remote-mode --symlink rejection (before network) ==\n'
  local isolated target
  isolated="$(mktemp -d "${TEST_ROOT}/isolated.XXXXXX")"
  cp "${REPO_ROOT}/scripts/install.sh" "${isolated}/install.sh"
  target="$(new_target)"

  run_install "${isolated}/install.sh" --symlink --target "$target" --ref does-not-matter
  assert_eq "$RUN_EXIT" "1" "remote-mode --symlink dies (exit 1)"
  assert_contains "$RUN_STDERR" "requires a local checkout" "remote-mode --symlink error names the reason"
  assert_not_contains "$RUN_STDOUT" "installing from" \
    "died before logging the remote fetch plan (no network reached)"
  assert_path_missing "${target}/.claude" "remote-mode --symlink rejection wrote nothing"
}

test_self_install_refusal() {
  printf '\n== self-install refusal (cwd and --target spellings) ==\n'
  local checkout
  checkout="$(new_checkout)"

  ( cd "$checkout" && bash scripts/install.sh --symlink >"$STDOUT_FILE" 2>"$STDERR_FILE" )
  RUN_EXIT=$?
  assert_eq "$RUN_EXIT" "1" "self-install refusal: bare cwd, no --target"
  assert_contains "$(cat "$STDERR_FILE")" "cannot symlink a checkout onto itself" "bare cwd: correct error"

  run_install "${checkout}/scripts/install.sh" --symlink --target "$checkout"
  assert_eq "$RUN_EXIT" "1" "self-install refusal: --target <checkout> (absolute)"
  assert_contains "$RUN_STDERR" "cannot symlink a checkout onto itself" "absolute --target: correct error"

  run_install "${checkout}/scripts/install.sh" --symlink --target "${checkout}/"
  assert_eq "$RUN_EXIT" "1" "self-install refusal: --target <checkout>/ (trailing slash)"
  assert_contains "$RUN_STDERR" "cannot symlink a checkout onto itself" "trailing-slash --target: correct error"

  ( cd "$(dirname "$checkout")" && bash "${checkout}/scripts/install.sh" --symlink \
      --target "$(basename "$checkout")" >"$STDOUT_FILE" 2>"$STDERR_FILE" )
  RUN_EXIT=$?
  assert_eq "$RUN_EXIT" "1" "self-install refusal: --target <relative>"
  assert_contains "$(cat "$STDERR_FILE")" "cannot symlink a checkout onto itself" "relative --target: correct error"

  ( cd "$checkout" && bash scripts/install.sh --symlink --target . >"$STDOUT_FILE" 2>"$STDERR_FILE" )
  RUN_EXIT=$?
  assert_eq "$RUN_EXIT" "1" "self-install refusal: --target . (dot)"
  assert_contains "$(cat "$STDERR_FILE")" "cannot symlink a checkout onto itself" "dot --target: correct error"

  assert_file "${checkout}/.claude/skills/autobots/SKILL.md" "checkout left intact after all self-install attempts"
}

# THE canon_path regression (see implementation-notes.md, "Re-review round"):
# a symlinked *destination agents directory* made the per-entry self-
# reference guard inert for every agent entry, because canon_path is
# cd-based and returns "" for an existing file argument. Reachable in
# minutes with a throwaway directory; this is the six-line test that would
# have caught it.
test_symlinked_agents_dir_attack() {
  printf '\n== symlinked-destination agents/ dir attack (THE canon_path regression) ==\n'
  local checkout target marker
  checkout="$(new_checkout)"
  marker="UNCOMMITTED_WIP_MARKER_$$"
  printf '%s\n' "$marker" >>"${checkout}/.claude/agents/planner.md"

  target="$(new_target)"
  mkdir -p "${target}/.claude"
  ln -s "${checkout}/.claude/agents" "${target}/.claude/agents"

  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink --force
  assert_eq "$RUN_EXIT" "1" "symlinked agents/ dir attack: installer dies instead of writing"
  assert_contains "$RUN_STDERR" "cannot symlink a checkout onto itself" \
    "symlinked agents/ dir attack: correct self-reference error"
  assert_contains "$(cat "${checkout}/.claude/agents/planner.md")" "$marker" \
    "source checkout survives intact (uncommitted marker still present)"
  assert_file "${checkout}/.claude/agents/advisor.md" "source checkout's agent files still exist"
}

test_copy_over_symlink_second_source() {
  printf '\n== copy-over-symlink from a second source ==\n'
  local checkout1 checkout2 target marker
  checkout1="$(new_checkout)"
  checkout2="$(new_checkout)"
  marker="SECOND_SOURCE_MARKER_$$"
  printf '%s\n' "$marker" >>"${checkout2}/.claude/agents/planner.md"
  target="$(new_target)"

  run_install "${checkout1}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "initial symlink install from checkout1 exits 0"

  run_install "${checkout2}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "0" "copy install from checkout2 without --force still exits 0 (conflicts, not a hard failure)"
  assert_contains "$RUN_STDERR" "conflict" "copy-over-symlink without --force reports a conflict"
  assert_symlink_to "${target}/.claude/agents/planner.md" "${checkout1}/.claude/agents/planner.md" \
    "without --force: dest still linked to checkout1"
  assert_not_contains "$(cat "${checkout1}/.claude/agents/planner.md")" "$marker" \
    "checkout1's own file untouched by the conflicting attempt"

  run_install "${checkout2}/scripts/install.sh" --target "$target" --force
  assert_eq "$RUN_EXIT" "0" "copy install from checkout2 --force exits 0"
  assert_not_symlink "${target}/.claude/agents/planner.md" "with --force: dest is now a real file, not a symlink"
  assert_contains "$(cat "${target}/.claude/agents/planner.md")" "$marker" "with --force: dest content came from checkout2"
  assert_not_contains "$(cat "${checkout1}/.claude/agents/planner.md")" "$marker" \
    "checkout1 (the original symlink target) remains untouched"
}

test_missing_source_dies_both_modes() {
  printf '\n== missing source file dies loudly, no dangling link (both modes) ==\n'
  local checkout target

  checkout="$(new_checkout)"
  rm -f "${checkout}/.claude/agents/advisor.md"
  target="$(new_target)"
  run_install "${checkout}/scripts/install.sh" --target "$target"
  assert_eq "$RUN_EXIT" "1" "copy mode dies on missing source"
  assert_contains "$RUN_STDERR" "Expected source file not found" "copy mode: correct die message"
  assert_path_missing "${target}/.claude/agents/advisor.md" "copy mode: no dangling entry for the missing agent"

  checkout="$(new_checkout)"
  rm -f "${checkout}/.claude/agents/advisor.md"
  target="$(new_target)"
  run_install "${checkout}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "1" "symlink mode dies on missing source"
  assert_contains "$RUN_STDERR" "Expected source file not found" "symlink mode: correct die message"
  assert_path_missing "${target}/.claude/agents/advisor.md" "symlink mode: no dangling symlink for the missing agent"
}

test_moved_checkout_recovery() {
  printf '\n== moved-checkout recovery via copy --force ==\n'
  local orig moved target
  orig="$(new_checkout)"
  target="$(new_target)"

  run_install "${orig}/scripts/install.sh" --target "$target" --symlink
  assert_eq "$RUN_EXIT" "0" "symlink install before the move exits 0"

  moved="${TEST_ROOT}/moved-checkout"
  mv "$orig" "$moved"
  if [ -L "${target}/.claude/agents/planner.md" ] && [ ! -e "${target}/.claude/agents/planner.md" ]; then
    pass "links are dangling after the checkout moves"
  else
    fail "links are dangling after the checkout moves"
  fi

  run_install "${moved}/scripts/install.sh" --target "$target" --force
  assert_eq "$RUN_EXIT" "0" "copy --force from the moved checkout exits 0"
  assert_not_symlink "${target}/.claude/agents/planner.md" "recovered entry is a real file, not a dangling link"
  assert_content_matches "${target}/.claude/agents/planner.md" "${moved}/.claude/agents/planner.md" \
    "recovered content matches the moved checkout"
}

test_empty_target_dies() {
  printf '\n== empty --target dies ==\n'
  local checkout
  checkout="$(new_checkout)"

  run_install "${checkout}/scripts/install.sh" --target ""
  assert_eq "$RUN_EXIT" "1" "--target '' dies"
  assert_contains "$RUN_STDERR" "requires a non-empty argument" "--target '' error message"

  run_install "${checkout}/scripts/install.sh" --target=
  assert_eq "$RUN_EXIT" "1" "--target= dies"
  assert_contains "$RUN_STDERR" "requires a non-empty argument" "--target= error message"
}

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

main() {
  printf 'Autobots install.sh test harness\n'
  printf 'REPO_ROOT: %s\n' "$REPO_ROOT"
  printf 'sandbox HOME: %s\n' "$HOME"
  printf 'payload entries per install: %s (%s agents + 1 skill)\n' "$TOTAL_ENTRIES" "$AGENT_COUNT"

  test_fresh_copy_install
  test_copy_reinstall_idempotent
  test_fresh_symlink_install
  test_symlink_reinstall_all_skip
  test_copy_conflict_without_force
  test_copy_force_overwrites
  test_symlink_conflict_real_file_without_force
  test_symlink_force_relink
  test_dry_run_writes_nothing
  test_remote_symlink_rejection
  test_self_install_refusal
  test_symlinked_agents_dir_attack
  test_copy_over_symlink_second_source
  test_missing_source_dies_both_modes
  test_moved_checkout_recovery
  test_empty_target_dies

  printf '\n----------------------------------------\n'
  printf 'Results: %d run, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
  if [ "$TESTS_FAILED" -gt 0 ]; then
    printf 'Failures:\n'
    local f
    for f in "${FAILURES[@]}"; do
      printf '  - %s\n' "$f"
    done
    exit 1
  fi
  exit 0
}

main "$@"
