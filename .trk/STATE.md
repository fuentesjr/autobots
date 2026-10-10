# STATE

## Goal
Fix the helper-worker grader defects; decide the eval measurement gap

## Dispatched
- [exp/autobots-progress] autobots-progress — Vendor savvy-progress (claude-kit 272a877) as mods/autobots-progress, roster-aware; autobots SKILL.md reports progress; evals held off by owner (2026-10-10T00:47Z)

## Next
1. helper-worker grader defects (needs new sha + approval): accept lib/ctxpack/-relative paths in ctx-missing-git-recon; let negated decoy mentions pass in ctx-app-root-discovery and ctx-stdout-json-version
2. Measurement gap: no eval covers planner, forensic-analyst, edge-case-analyst, advisor; no stop-tempting or spec-test-dispute case in the implementer evals. Owner decides whether to build either.

## Backlog
- add-refactoring-specialist — Port optimites' refactoring-specialist role (structural, multi-file, behavior-preserving refactoring; hard characterization-test gate before restructuring) into Autobots as a new .claude/agents/ role. Spec lives at optimites/.grok/agents/refactoring-specialist.md; translate to Claude Code frontmatter/model conventions. Autobots' ten-role roster currently lacks this role. (2026-07-20T23:22Z)
- routing-gate-spec-test-writer — Routing gate: new PREREG adding a spec-test-writer case and deciding coding-normal's expected role under the spec-first recipe (2026-10-07T02:51Z)
- port-role-eval-to-evalkit — Replace RoleEval.wilson and RoleEval's claude -p launcher with evalkit wilson.rb and claude_session_runner.rb. Blocker: evalkit's runner builds argv with no --agent or --effort (claude_session_runner.rb build_argv), so it needs an evalkit change first. Changing role_eval.rb changes the harness sha of the coding-worker, reviewer, and spec-test-writer certifications; do it after spec-test-writer RESULTS freeze and plan reruns. Owner decides (new dependency). (2026-10-07T23:55Z)
