# Implementation notes

## Task 1 — restore `.claude/skills/autobots/SKILL.md`

Restored via `git checkout d2ed181^ -- .claude/skills/autobots/SKILL.md` (d2ed181 is `HEAD`,
confirmed with `git rev-parse HEAD`). Skimmed the restored content against the current repo:
roster (ten role names), model routing (`CLAUDE_CODE_SUBAGENT_MODEL` caveat), and pattern
registry all match `docs/spec.md` §3/§7 and `scripts/validate_package.go`'s `expectedRoster`
exactly — no contradictions found. `go run ./scripts/validate_package.go` passes with the file
in place (it was failing before the restore, since `VAL-1/2/...` read `.claude/skills/autobots/SKILL.md`
directly).

## Task 2 — `--symlink` installer option

**Design.** Local-checkout mode only; `die`s in remote (curl-pipe) mode before touching the
network. Skill: single directory symlink `<DEST_ROOT>/skills/autobots` → `<checkout>/.claude/skills/autobots`
(not the file — the destination shape changes from copy mode, which targets the `SKILL.md` file
directly). Agents: per-file symlinks `<DEST_ROOT>/agents/<name>.md` → `<checkout>/.claude/agents/<name>.md`,
since the agents directory isn't Autobots-owned. Targets are always absolute (resolved from
`LOCAL_REPO_ROOT`, which is itself derived via `cd ... && pwd`).

Added a parallel `install_symlink()` function next to the existing `install_file()`; kept them
separate rather than unifying, since the compare/replace logic (`cmp` vs. `readlink`, `cp` vs.
`ln -s`, `-f`/`-e` vs. `-L`) differs enough that a shared implementation would need branching at
nearly every step. Overwrite semantics mirror `install_file`'s: unchanged → skip, differing
without `--force` → conflict (untouched), differing with `--force` → replace, `--dry-run` →
preview only. On `--force` replacement the destination is `rm -rf`'d before `ln -s` (never
`ln -sfn`), so an existing real directory can't swallow the new symlink as a nested entry.

Did not touch the `AGENTS=( ... )` literal array — `scripts/validate_package.go`'s `checkVAL11`
parses it token-by-token and both symlink and copy paths iterate the same array, so no parser
changes were needed.

**Docs updated:** `docs/spec.md` (new `INS-8`), `docs/design.md` ("Installation Script" section,
new "`--symlink`: live-source installs" subsection with the copy-vs-symlink rationale),
`README.md` (options table + a paragraph in Install), `docs/cheatsheet.md` (example command).
`docs/spec.md` INS-1's flag table intentionally left unchanged — it's explicitly framed as "the
Agenticons flag surface, unchanged" (a parity statement), so the new Autobots-only flag lives in
its own `INS-8` requirement instead.

**Verification** (from repo root unless noted):

- `go run ./scripts/validate_package.go` — all 13 checks PASS, both before and after the restore/edits.
- `go vet ./...` — clean.
- `go test ./...` — `8 passed in 1 packages`.
- `shellcheck scripts/install.sh` — one pre-existing warning (`SC2034`, unused `SCRIPT_NAME`,
  present before this change too — confirmed by running shellcheck against the `d2ed181` copy of
  the script); no new warnings from the `--symlink` addition.
- Manual runs against throwaway targets under `/private/tmp/.../scratchpad/autobots-test/`
  (never `--global`, so `~/.claude` was never touched):
  - Plain install into a fresh target → 11 created, all regular files (confirmed `[ -L ... ]` false).
  - `--symlink` install into a fresh target → 11 linked; `readlink` on the skill dir and two agent
    files resolves to the absolute checkout path; `diff` against the checkout source shows
    identical content.
  - `--symlink` re-run on the same target → 11 skipped (unchanged).
  - `--symlink` (no `--force`) over a plain-copied install → 11 conflicts, destination left as
    regular files/dir (confirmed `[ -L ... ]` still false and `SKILL.md` still present).
  - Same, with `--force` → 11 relinked; confirmed the skill destination became a symlink with no
    nested leftover file from the old real directory.
  - `--dry-run` on a fresh target (plain and `--symlink`) → all "would-*", nothing written
    (confirmed target directory stayed empty).
  - `--dry-run --force --symlink` over an existing copied install → all "would-relink", confirmed
    destination was still a real directory afterward (no changes applied).
  - `--symlink` in simulated remote mode (script copied alone to an isolated directory with no
    sibling checkout markers, so local-checkout detection fails) → `die`s with exit code 1 and a
    clone-first message, before any network call or misleading "installing from remote" log line
    (reordered the check to fire inside the `MODE="remote"` branch, ahead of that log line).

**No existing installer test harness.** The only test file in the repo is
`scripts/validate_package_test.go` (Go tests for the validator, unrelated to the installer script
itself). There is no bats/shell test harness for `install.sh` to extend, so verification for this
option rests on the manual runs above plus `shellcheck`.

**Residual risk / open questions (superseded, see rework round below):** the first pass reported
"none identified," but a review pass found a blocker and four should-fixes not covered by the
verification matrix above (self-install, mixed symlink/copy sequences, missing targets, moved
checkouts). See below.

## Rework round — review findings

Reviewed against my first-pass `--symlink` implementation; all fixes are in `scripts/install.sh`
unless noted. No test harness was built and `.github/` was not touched (parked as an owner
decision per the rework brief).

1. **BLOCKER — self-referential install.** Added `canon_path()` (walks up to the nearest existing
   ancestor, resolves it via `cd ... && pwd -P`, reattaches the unresolved suffix — handles
   destinations that don't exist yet, which BSD `realpath` can't). Two guards:
   - Upfront: right after `MODE` resolution, compares canonicalized `DEST_ROOT` against
     canonicalized `${LOCAL_REPO_ROOT}/.claude`; dies with "cannot symlink a checkout onto itself"
     before any per-entry work. Fires for `--dry-run` too (unconditional `die`, no dry-run guard).
   - Per-entry, inside `install_symlink()`: compares canonicalized `target` against dest, but
     **not** by canonicalizing `dest` directly — that would follow an existing correct symlink at
     `dest` straight to `target` and falsely fire on every legitimate re-run (caught by testing;
     see below). Instead resolves `dest`'s *parent* directory only and reattaches `dest`'s own leaf
     name unresolved, so it catches "the leaf's parent directory physically is the target" (the
     real hazard) without tripping on "the leaf is already a correct symlink to the target" (the
     benign, expected case).
   - `--target <checkout>/subdir` deliberately still resolves to a different physical path than
     `<checkout>/.claude` and remains legal — verified.

2. **`install_file` symlink-blind.** Rewrote `install_file()` to check `[ -L "$dest" ] || [ -L
   "$dest_dir" ]` first (catches both a symlinked leaf — an agent file — and a symlinked parent —
   the skill directory link). `-L` is true for dangling links too (unlike `-e`/`-f`), so this also
   covers a moved/deleted source checkout (finding 4). Treated as its own conflict class, wording
   mirrors `install_symlink`: refuses without `--force` ("... is reached through a symlink ...
   from a prior --symlink install"), and with `--force` removes the link itself (`rm -f`, not
   `rm -rf` — it's just a link entry) before `cp` writes a real file/dir at the destination.

3. **`install_symlink` never checked target existence.** Added `[ ! -e "$target" ] && die
   "Expected source file not found: $target"` at the top of `install_symlink()`, matching
   `fetch_to_tmp`'s message shape exactly.

4. **Moved/deleted checkout.** Covered by fix #2 (`-L` catches dangling links, so `install_file`
   removes the stale link and proceeds instead of `mkdir -p` hitting a raw "File exists"). Verified
   directly: symlink-install → `mv` the checkout to a new path → copy-install `--force` from the
   renamed path → succeeds cleanly, no raw mkdir error.

5. **Wording.** `install_symlink()`'s conflict/dry-run paths now branch on `[ -d "$dest" ]` for the
   real-file/dir case: conflict warning gains "--force will delete it and its contents to replace
   it" for directories; `--dry-run` labels split into `[would-relink]`/`[relinked]` (benign —
   replacing a symlink to a different target) vs. `[would-replace]`/`[replaced]` (destructive when
   dest is a real directory, "(--force will delete it and its contents)" appended). Same qualifier
   added to `docs/spec.md` INS-8's overwrite-semantics bullet.

**Adjacent items:**

- (a) `docs/design.md`: rewrote the convention statement to say precisely that `~/.claude/skills/<name>`
  symlinks to a directory whose *top level* contains `SKILL.md`, and that Autobots' own `SKILL.md`
  is nested one level below the checkout root, so the link target must be `.claude/skills/autobots`
  specifically (linking the repo root would leave `SKILL.md` a level too deep). Did not assert as
  verified fact that this specific mistake caused the historical destruction of the global copy —
  only the coordinator claimed that; I have no independent evidence, so I described the shape of
  the bug without asserting its historical cause.
- (b) `README.md`: added a one-line caveat that `--symlink` produces machine-specific absolute
  links, meant for the maintainer's own setup, not a `--target` repo that commits `.claude/`.
- (c) Empty `--target ""` (both `--target ""` and `--target=` forms) now dies with "--target
  requires a non-empty argument" instead of silently falling back to `pwd` and bypassing the
  `--global` mutual-exclusion check.

**Also fixed during verification (not in the original finding list, found by testing):** the
per-entry self-reference guard's first draft canonicalized `dest` directly, which produced a false
"cannot symlink a checkout onto itself" die on every `--symlink` re-run (once the correct symlink
exists, canonicalizing it resolves to the target, matching by construction). Fixed by resolving
only `dest`'s parent directory and reattaching the leaf name unresolved, per finding 1's writeup
above. Caught by the expanded re-run test before reporting back — not by inspection.

**Expanded verification (rework round), all under a fresh scratch copy of the checkout at
`/private/tmp/.../scratchpad/rework/checkout` (and disposable siblings `checkout2`/`checkout3-missing-agent`/
`checkout-move-*` for cross-source and moved-checkout scenarios), never touching `~/.claude`:**

- `bash -n scripts/install.sh` — syntax OK.
- `shellcheck scripts/install.sh` — only the pre-existing `SC2034` (`SCRIPT_NAME`) warning.
- `go run ./scripts/validate_package.go` — 13/13 PASS.
- `go vet ./...` — clean.
- `go test ./...` — pass (`ok github.com/fuentesjr/autobots/scripts`).
- Original matrix re-run against the current script: plain copy install (11 created, all real
  files); `--symlink` install (11 linked, `readlink` confirms skill → `.../checkout/.claude/skills/autobots`,
  agent → `.../checkout/.claude/agents/<name>.md`); `--symlink` re-run (11 skipped, unchanged —
  this is what caught the false-positive self-reference bug above); dry-run fresh (copy and
  symlink) → all "would-*", nothing written; dry-run over the already-symlinked target → all
  skipped.
- `--symlink` over a plain-copied install, no `--force` → 11 conflicts; skill warning names the
  recursive-delete consequence, agent warnings use the plain "use --force to replace" wording;
  destination confirmed still real files/dir afterward.
- `--dry-run --symlink --force` over the same copied install → `[would-replace] ... (--force will
  delete it and its contents)` for the skill, `[would-replace]` (no qualifier) for agents;
  destination confirmed untouched.
- `--symlink --force` over the copied install → 11 replaced; `readlink` confirms correct targets,
  `find` on the skill's destination shows no nested leftover directory.
- Self-install refusal: `--symlink`, `--symlink --force`, `--symlink --dry-run`, all run from `cwd`
  inside the checkout with no `--target`/`--global` → all die with "cannot symlink a checkout onto
  itself", exit 1, before any writes.
- Self-install refusal via `--target` spellings: exact checkout path, checkout path with a
  trailing slash, and a relative path (`./checkout` from the parent dir) → all die with the same
  message (the relative-path run's message shows the unresolved literal in the first clause and
  the canonicalized form in the second, since only the latter is compared).
- `--target <checkout>/subdir` → dry-run symlink install proceeds normally (11 would-link), not
  flagged as self-referential — confirms the subdir case remains legal.
- Copy-over-symlink from a *different* source checkout (`checkout2`, content-marked to distinguish
  it): without `--force` → 11 conflicts, destination still linked to `checkout` (`readlink`
  confirms), `checkout`'s own working tree has zero occurrences of `checkout2`'s marker. With
  `--force` → 11 updated ("replaced symlink with a real copy"), destination now real files
  containing `checkout2`'s marker (`grep -c` = 1), and `checkout` (the originally linked-to source)
  still has zero occurrences of the marker — confirms the write landed in the destination, not
  through the link into the first checkout.
- Missing-source die in symlink mode: source checkout with `advisor.md` deleted → symlink-install
  processes the skill and nine agents, then dies loudly on the tenth ("Expected source file not
  found: .../advisor.md"), exit 1; confirmed no dangling link was left for the missing entry
  (`-e` and `-L` both false).
- Moved-checkout recovery (finding 4): symlink-install from `checkout-move-orig` → `mv` it to
  `checkout-move-renamed` (destination links now dangling, confirmed) → copy-install `--force`
  from the renamed path → succeeds cleanly (`[updated] ... replaced symlink with a real copy` for
  all 11 entries, no raw mkdir error); destination confirmed real files with `SKILL.md` present.
- Empty `--target`: `--target ""`, `--target=`, and `--global --target ""` all die with "--target
  requires a non-empty argument", exit 1.

**Residual risk / open questions:** none identified after the expanded matrix. Two design notes
worth flagging for future review, not fixed here since they're outside the requested scope: (1)
`install_symlink`'s per-entry self-reference die message reports the *unresolved* literal path in
its first clause when the destination is a relative `--target` — cosmetic only, the underlying
comparison is correct (verified above); (2) the upfront `DEST_ROOT`-level guard and the per-entry
guard are intentionally redundant (defense in depth per the brief) — the per-entry guard is
strictly necessary (it also protects `--global`-adjacent edge cases the coordinator didn't call
out, and covers the case where `DEST_ROOT` itself is fine but a specific entry's target isn't),
but this means the two checks must be kept in sync if either's canonicalization logic changes.

## Re-review round (orchestrator fix)

Re-review found the per-entry guard was inert for all ten agent entries: `canon_path` is
cd-based, so an existing *file* argument returns "" and the comparison could never match —
reproducible checkout destruction via a symlinked destination `agents/` directory. Fixed by
resolving the target parent-then-leaf, mirroring the dest side (one line), plus a
directory-only contract comment on `canon_path`. Verified: the symlinked-agents-dir attack now
dies with the self-reference error and the checkout (including an uncommitted WIP edit)
survives; fresh symlink install 11 created, re-run 11 skipped; shellcheck unchanged (SC2034
pre-existing only); validator all-pass. Parked owner decisions: an executable install.sh test
harness in CI (both review rounds argue for it — this hole was a one-probe find), and whether
`--symlink` belongs in spec INS-1's flag table or only in INS-8.
