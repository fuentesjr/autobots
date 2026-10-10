# LOG

## 2026-09-29T22:08Z log
Ruby port of routing_gate/role_eval/role_judge landed (uncommitted): Minitest 16 runs green; null+oracle selftest 12/12 each; routing gate n=1 11/11 (claude-sonnet-5-5); summary output matches Python; judge order reproduces all 24 recorded rows. Python removed. Harness sha changed (runner renamed), so new measured runs need owner --approve-harness.

## 2026-09-30T17:30Z log
fcw eval started 17:29Z: harness 3b514fd03be1 approved by owner; baseline (low) via nohup -> runs/baseline.log, v1 (medium) background task

## 2026-09-30T18:20Z log
fcw eval done: RESULTS frozen (30/30 both arms, 1.06x wall) -> adopted medium; roster edit applied uncommitted, checks green. Reviewer eval: 20 items selftest ok; owner approved harness f7a22575c9eb; PREREG frozen 18:19Z sha256 d2f8dc86; both arms started 18:20Z under caffeinate -ims (nohup, runs/baseline.log, runs/v1.log)

## 2026-09-30T23:19Z log
Reviewer eval interrupted ~19:00Z by subscription session limit ('You've hit your session limit · resets 1:30pm PT'). QUOTA_RE in role_eval.rb misses that wording, so the runner kept going: every remaining attempt failed fast as served_model_mismatch (empty modelUsage). Valid rows: baseline 5, v1 2. Errors: baseline 38, v1 41, none scored. No processes running. Waiting on owner: resume plan + quota-regex harness fix (needs sha re-approval).

## 2026-10-04T21:44Z log
Owner decision 2026-10-04: planner, forensic-analyst, edge-case-analyst, advisor effort xhigh->high. Basis: Fable 5.1 prompting guide (start at high; xhigh only for a measured gain); no Autobots measurement either way. Edited 4 agent files, validator expectedRoster, spec, design, cheatsheet, README, SKILL.md. Checks: validator pass, go test ok, test_install 84/0, skill-lint 0 errors 4 warnings. Uncommitted; live already because ~/.claude/agents symlinks into this repo. Also deleted two user-level agents on owner instruction.

## 2026-10-04T21:54Z log
2026-10-04 prompt review closed out. Owner approved and I applied: stop-sentence rewrite in coding-worker and fast-coding-worker bodies (9fa2491), AGT-11 non-delegation clause dropped from spec and faq (df03d31), effort retune committed (b3473d8). All on main, not pushed. Outside the repo: deleted two user-level agent files and updated one memory file. Checks: validate_package all passed, go test ok, test_install 84/0. Body and effort changes are unmeasured.

## 2026-10-07T01:37Z log
Owner decision 2026-10-06: proposed spec-test-writer role uses sonnet, effort high (not fable). Backlogged as add-spec-test-writer behind the reviewer eval.

## 2026-10-07T01:47Z log
spec-test-writer added (owner approved 2026-10-06: add role; guard = prompt scope + orchestrator diff check). sonnet/high, writable. Edited agent file (new), spec (ART-1/3, AGT-1/2/3/8/12, SKL-6, PAT-6, VAL-14, ACC-5), validator expectedRoster, install.sh, SKILL.md (roster, spec-first recipe, parallel list), README, design, faq, cheatsheet. Checks: validator all passed, go test ok, go vet clean, test_install 84/0, skill-lint 0 errors 4 warnings (unchanged). Uncommitted. NOT installed (install.sh not rerun): no certification yet. Routing scenarios frozen, so no routing case for the new role; coding-normal (a feature) may now route to spec-test-writer.

## 2026-10-07T02:51Z log
Committed roster change (spec-test-writer) and skillset procedures edits (228d809), owner approved; not pushed. Routing-gate PREREG item parked by owner 2026-10-06. Consulting Fable (planner) on a simpler certification eval.

## 2026-10-07T02:59Z log
Fable (planner) eval consult for spec-test-writer: reuse the 10 coding-worker/reviewer cases (12 cases and 30 reviewer patches confirmed on disk); Fable rewrites briefs blind to the role prompt; grade red at base, green on every known-good implementation, kill one mutant per stated behavior, test-paths-only; new scripts/spec_eval.rb requiring role_eval.rb unchanged; 10x2, certify >=17/20 and no case 0/2. Awaiting owner go-ahead.

## 2026-10-07T16:12Z log
spec-test-writer eval: Fable fixtures done (10 cases, 31 mutants, 29 refs; blind to role prompt, verified from transcript); scripts/spec_eval.rb + test written; selftest 10/10 ok (25.6 min); e2e grade check on ctx-b7 with the hidden test as role tests: red/green ok, kill caught 2 survivors as expected. Awaiting owner --approve-harness.

## 2026-10-07T23:55Z log
Owner chose: keep custom role_eval harness for spec-test-writer certification; evalkit port backlogged (port-role-eval-to-evalkit); keep raw 17/20 gate.

## 2026-10-08T00:06Z log
spec-test-writer eval: design approved, fixtures and harness built (scripts/spec_eval.rb), selftest all 10 cases ok; superseding next item 6 with the remaining steps.

## 2026-10-08T00:14Z log
Owner approved 2026-10-07: commit of dispute rule (d2845db), spec-test-writer harness sha cdc0ec7b5e20, Haiku 5.5 arms low/medium/high. Smoke run started (ctx-b7, 2 reps). Open: keep or drop the implementer's self-permission to make a loose assertion exact; decide before fcw recert.

## 2026-10-08T00:21Z log
Committed 9e98c30 (implementers change an existing assertion only when the brief asks; owner approved). spec-test-writer smoke: 1/2, ~7 min wall; rep0 green fail = role fault (assert_includes prefix vs array of lines; reproduced on clean.patch). No harness change. PREREG frozen sha256 293308bd616a. Awaiting owner approval of scored run (10x2, conc 3, est ~45-60 min, max ~1.5 h).

## 2026-10-08T23:58Z log
Owner 2026-10-08: approved scored spec-test-writer run (started, runs/baseline.log); harness committed 1a5e617 after PII scan (clean); fcw moves to Haiku 5.5, eval only picks effort (low/medium/high); helper-worker eval approved, build dispatched to coding-worker (selftest only, no model runs). role_eval harness sha now 988dde100c78, not the fcw-approved 3b514fd03be1 (role_eval.rb mtime 2026-09-30 16:40 PT, after fcw run); needs owner approval before fcw run.

## 2026-10-09T00:07Z log
helper-worker eval built by coding-worker (uncommitted, untracked scripts/helper_eval.rb + test; fixtures gitignored). Verified: unit 9/29/0, selftest 10/10 ok, harness sha 415e8b7051c1 (not approved), PREREG DRAFT with decision rule blank. Scored spec-test-writer run resumed after --max-sessions 3 cap stopped it at 3/20 (my error: cap is total sessions).

## 2026-10-09T00:12Z log
Owner 2026-10-08 approved: role_eval sha 988dde100c78; fcw Haiku effort rule (lowest within 1 of best, no case 0/3, floor 27/30) -> PREREG-haiku-effort.md frozen; roster/spec edits after effort picked; helper sha 415e8b7051c1 + smoke; helper rule (Haiku within 2 of Sonnet low, no 0/3, wall <= Sonnet) filled in PREREG (freeze after smoke). Q6 (commit helper_eval.rb) unanswered. Order: spec-test-writer -> fcw v2/v3/v4 -> helper smoke -> helper scored.

## 2026-10-09T00:31Z log
spec-test-writer scored run done: 19/20, no case at 0/2 -> CERTIFIED; RESULTS.md frozen. Install awaits owner approval.

## 2026-10-09T00:52Z log
spec-test-writer installed globally (scripts/install.sh --global --symlink; ~/.claude/agents/spec-test-writer.md -> checkout). Owner accepted: no prompt change now; add the setup-condition sentence to Precision and recertify only if an implementer disputes a spec test whose setup exceeded the requirement; testing-principles doc stays out of role prompts; spec tests keep the no-unit-test rule; coding-worker recert runs last, after fcw Haiku and helper-worker evals.

## 2026-10-09T19:54Z log
2026-10-09: fcw Haiku effort eval frozen (low 27, medium 29, high 29 of 30; medium adopted; roster edit uncommitted, reviewed). helper-worker Haiku eval frozen: baseline Sonnet low 27, Haiku low 28, medium 28, high 29 of 30; no Haiku arm passed the wall-time gate (15.25/16.35/18.05 s vs 15.1 s), keep Sonnet low; 4 of 6 failures are grader defects. coding-worker recert on 9e98c30: 24/24. Reviewer stage 1: high 29/34, below ceiling 31, stage 2 needed (~58 Fable sessions, not approved). cafup -s fix committed in ~/skillset 3c5f5c7 (feat/cafup, unpushed).

## 2026-10-09T23:46Z log
2026-10-09: roster edit committed. Owner declined reviewer stage 2 (Fable cost): reviewer stays at high; eval closed at stage 1 (29/34), not run further. Owner kept helper-worker on Sonnet low. Handoff deleted.

## 2026-10-09T23:54Z log
2026-10-09: installer minimum 2.1.293 committed (aae51fd); autobots main pushed. skillset main rebased onto origin and pushed; feat/cafup pushed (3c5f5c7), PR text awaiting owner sign-off.

## 2026-10-10T00:19Z log
RoleEval refactor landed (12f9649, 4af4daa); every harness sha changed, each flow needs --approve-harness before its next run. Clean-checkout fix for test_grade_reruns_a_flaky_suite_once pending commit.

## 2026-10-10T00:34Z log
Clean-checkout test fix landed; helper-worker grader defects stay in Next, not started (owner).

## 2026-10-10T01:07Z log
autobots-progress: review done (no blockers); added 9 spec tests (46 pass), README section, SKILL phase trim; mutants on price/window/case all killed. Uncommitted. Open for owner: drop step tool?, commit split, live-try/install of SKILL.md. Evals deferred by owner.

## 2026-10-10T01:18Z log
autobots-progress committed on exp/autobots-progress: e8e4166 (vendor verbatim), 96e5ec4 (adaptation). tsc clean, 46 tests pass. Open: drop step tool (owner), evals for SKILL.md deferred, not pushed/installed.

## 2026-10-10T03:51Z log
autobots-progress: observed activity column committed (33b5523) on exp/autobots-progress; 75/75 tests, tsc, validate green. Bash summary hides NAME=value prefixes (quoted too) and directories. Open: owner decision on Grep/Glob display (S1). Not pushed; evals not run; SKILL.md not installed.
