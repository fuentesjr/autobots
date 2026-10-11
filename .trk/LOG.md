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

## 2026-10-10T15:32Z log
autobots-progress: band text fix 4c404d9; terminal crabs+tiles 59622da (87/87, tsc, validate). Owner 2026-10-10: commit freely on exp branch, no merge/rebase to main until owner tests; live test in herdr pane, no Fable agents there; Fable reviewer ok; planned rows match desktop (dimmed crab); loose tile test ok. Next: per-role crabs (12, owner-approved traits, 5 bodies as base), spec tests in progress; then review, live herdr test.

## 2026-10-10T15:32Z log
Owner 2026-10-10: terminal Collapse mode should show a strip of crab Images like the desktop; do it after the 12 per-role crabs.

## 2026-10-10T15:37Z log
autobots-progress: Fable review of 59622da: C1 per-group accent, C3 planned rows, C4 stats wrap, N1 rgbaOf, N2 shared rule relayed to the per-role crab coding-worker; N3 (no test for <42 cols/Collapse) parked for the Collapse-strip spec step. README fullscreen tip written (uncommitted).

## 2026-10-10T15:53Z log
autobots-progress live herdr test (forced images, fullscreen env): panel rows and planned rows reserve the 6-col crab Image (no ▣ alt), no render refusals in debug log; keyboard: ctrl+x tab focuses band, second ctrl+x tab the panel, tab reaches Collapse/Finished/✕, enter toggles Collapse<->Expand. Pixels not seen by me (screencapture denied). Next: spec tests (band fit, exact dim, other crab), coding-worker fixes, Fable review of a8d35a6.

## 2026-10-10T16:09Z log
autobots-progress: spec round 2 (band fit, exact dim, plain crab, strip order newest-first both surfaces [my decision: match the expanded panel], fit lower bound, ● adjacency) + coding-worker fixes: 146/146, validate, tsc clean. Live herdr 83 cols: 'Review 12/12 ×12' band fits one line. Fable review of the fix diff running. Uncommitted.

## 2026-10-10T16:17Z log
autobots-progress committed 7dd5b5c (README herdr note) and 7a70e82 (band fit, strip order newest-first both surfaces, desktop dot moved, exact dim, spec tests): 146/146, validate, tsc; Fable review: nothing blocking (nits: bar 6-col floor can overflow below ~56 cols; test cells() wide-char table unused). Live herdr pane w2M:p2 left open. Not pushed, not merged.

## 2026-10-10T21:54Z log
autobots-progress: 3b-commit skip SubagentHandback in activity (owner approved 2026-10-10), 153/153, validate, tsc. Owner: crabs stay clay with role-colored props; no upstream report; README herdr note kept; SKILL.md stays live while owner tests; untracked files stay. Pending owner: helper-worker prop (redraw backpack vs flashlight), Grep/Glob display A/B/C. Fable review to batch with those.

## 2026-10-10T22:13Z log
autobots-progress: helper-worker flashlight (edb6051) and Grep/Glob secret filter committed; 210 tests pass; Fable review findings 1-5 fixed, 6/7/9 added; one-digit run rule kept pending owner

## 2026-10-11T01:58Z log
Owner kept the strict one-digit random-run rule in looksSecret (2026-10-10)

## 2026-10-11T02:10Z log
Handoff: 88 spec tests for masking secrets in titles/descriptions/Bash file name are uncommitted in tests/autobots-progress.test.ts (72 fail by design); implementation not started; continuing in a new session

## 2026-10-11T02:12Z log
autobots-progress: session start; baseline 226 pass / 72 fail (section 8 secret masking). Dispatching coding-worker.

## 2026-10-11T02:13Z log
Owner dropped the stale built-in agent-list investigation (2.1.296) for now (2026-10-10).

## 2026-10-11T16:28Z log
autobots-progress: secret masking implemented (maskSecrets reuses looksSecret/SECRET_SHAPES; display only). Owner's shell: 298/298 pass in 21.7s; tsc clean, validate ok. 'claude plugin test' hangs ~1h at 0% CPU from the agent's sandboxed Bash, even with HEAD register.tsx: environment, not code. Reviewer next.

## 2026-10-11T16:29Z log
autobots-progress live herdr check (new pane w2M:p4; w2M:p2 was gone): subagent description 'rotate <fake sk- key> key' shows 'rotate ••• key' in the panel. Claude Code's own transcript and agent list show it raw (outside the mod).

## 2026-10-11T16:34Z log
autobots-progress: review found spanning-value leak (Basic, quoted passphrase); spec rows + 512-char test added (512 rule pending owner), shape widened, unclosed quote runs to end. 318/318 (run unsandboxed: sandbox caused the 1h hangs), tsc 0, validate ok. Re-review running.

## 2026-10-11T16:52Z log
autobots-progress committed 4b2e99f: secret masking in titles/descriptions/Bash file name; owner approved 512-char title rule (2026-10-11). 322/322, tsc 0, validate ok, reviewer: no blockers. Live pane w2M:p4 left open. Not pushed, not merged. Note: run 'claude plugin test' unsandboxed; it hangs in the Bash sandbox.

## 2026-10-11T17:04Z log
Owner approved: added CLAUDE_CODE_PLUGIN_DIRS (autobots-progress) and CLAUDE_CODE_PLUGIN_DIR_WATCH=1 to ~/.claude/settings.json env for desktop-app testing (2026-10-11). Remove after testing; backup in session scratchpad.

## 2026-10-11T17:12Z log
Owner confirmed autobots-progress works and looks right in the desktop app's Code tab local session (2026-10-11). Note: a chat-tab session with a folder attached is not Claude Code and cannot load mods. Settings env keys still in place.

## 2026-10-11T17:20Z log
Merged exp/autobots-progress into main (1c5dbf6, --no-ff, owner request 2026-10-11, no PR, not pushed); 322/322 on main. Includes autobots SKILL.md progress-reporting section, UNCERTIFIED: skill-lint + eval suite not run (repo rule); owner chose to merge anyway. Follow-up: certify SKILL.md change. Also committed .gitignore for generated mod tsconfig.json and .gitattributes union merge for trk log.

## 2026-10-11T17:32Z log
Committing .trk/LOG.md backlog on main (owner approved 2026-10-11).
