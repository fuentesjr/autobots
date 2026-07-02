# Autobots FAQ

## What is Autobots? How is it different from just using subagents directly?

Autobots is a fixed, named roster of ten Claude Code subagents — `planner`, `coding-worker`, `fast-coding-worker`, `helper-worker`, `forensic-analyst`, `doc-reviewer`, `reviewer`, `qa-engineer`, `edge-case-analyst`, and `advisor` — each with a pinned model tier, a pinned reasoning effort, a fixed access class (read-only or writable), and a defined output contract. You could hand-roll ad hoc subagents in any project, but you'd be redeciding the model, the tool allowlist, and the responsibilities every time. Autobots ships that roster once, as files, so every project that installs it gets the same consistent routing: the same task always lands on the same role, running the same model, with the same guardrails. It's the Claude Code counterpart to [Agenticons](https://github.com/fuentesjr/agenticons), which does the same thing for Codex.

## How do I trigger it? How do I turn it off?

Dispatch is opt-in — it never fires automatically. Ask explicitly for one of: autobots, subagents, delegation, parallel execution, or model-tier routing. The `/autobots` slash command triggers the same dispatcher directly.

Escape hatches always win, even if your request otherwise sounds like an autobots task. Say any of: `no subagents`, `do not use subagents`, `handle locally`, `do this yourself`, or `do not use autobots`, and the parent handles the task itself without dispatching to any role.

## What are the ten roles, and when does each get used?

| Role | Used for |
|---|---|
| `planner` | Architecture, decomposition, sequencing, and risk analysis before implementation starts. Read-only — it returns a plan, never edits. |
| `coding-worker` | Normal-scope implementation: features, bug fixes, refactors. Writable. |
| `fast-coding-worker` | Small, localized edits and quick fixes where speed/cost matters more than depth. Writable. |
| `helper-worker` | Fast reconnaissance and evidence-gathering before another role acts — "where is X, what does Y currently do." Read-only. |
| `forensic-analyst` | Deep root-cause investigation for intermittent, cross-system, or hard-to-reproduce failures. Read-only; returns a forensic report. |
| `doc-reviewer` | Checking documentation for correctness and drift against the actual code. Read-only. |
| `reviewer` | Standard code review: correctness, security, maintainability, regressions, missing tests — including high-stakes/security-sensitive review. Read-only. |
| `qa-engineer` | Exploratory QA that exercises a change end-to-end after it lands — regressions, performance, UX rough edges. Writable (it may edit to scaffold verification), but it returns findings, not a merged feature. |
| `edge-case-analyst` | Coverage-gap discovery: finds cases nobody considered and proposes concrete specs and test cases. Read-only. |
| `advisor` | Guidance-only consultant for the `advisory` pattern. Returns exactly one of a plan, a correction, or a stop signal. Read-only; never edits; never produces user-facing output. |

A typical flow chains a few of these: `planner` → `coding-worker` → `reviewer` is the default plan/implement/review recipe. `helper-worker` often runs first when the parent needs facts before deciding scope.

## Why is per-role model routing broken if `CLAUDE_CODE_SUBAGENT_MODEL` is set?

Claude Code resolves a subagent's model in a fixed precedence order, and the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable wins if it's set — ahead of the frontmatter `model:` field that pins each Autobots role to its intended tier. With the variable set, every role — `planner`, `coding-worker`, `fast-coding-worker`, `helper-worker`, `forensic-analyst`, `doc-reviewer`, `reviewer`, `qa-engineer`, `edge-case-analyst`, and `advisor` alike — silently collapses onto whatever single model the variable names, regardless of what its `.md` spec says. There is no error or warning at dispatch time; the roster just quietly stops being a roster. `scripts/install.sh` checks for this variable and warns if it's set, and `README.md` documents the fix: unset it before relying on per-role routing.

## What patterns exist? How does the advisory consult loop work?

Autobots ships two registered patterns:

- **`orchestrator-worker` (default)** — used for any autobots dispatch that doesn't name another pattern. The parent delegates bounded subtasks to whichever of the ten roles fits, gets results back, and synthesizes the final answer itself.
- **`advisory`** — triggered by `use the advisor strategy`, `advisory pattern`, or an explicit ask for a cheap executor paired with an advisor. It pairs one writable executor (`coding-worker` for normal work, or `fast-coding-worker` for maximum cost reduction) with the read-only `advisor` role.

The advisory loop is **parent-mediated**, not peer-to-peer: the executor cannot call `advisor` directly, because the type-restricted `Agent(advisor)` allowlist syntax is ignored once an agent is itself running as a subagent, and granting the executor the `Agent` tool at all would break the one-level-deep delegation invariant every role must respect. So instead:

1. The parent dispatches the executor with the task, plus an appended consult protocol: work autonomously, and if you hit a decision you can't reasonably resolve, stop and return a structured consult request (the question, the options considered, and pointers to relevant files/evidence).
2. The parent forwards that consult request to `advisor`, which returns exactly one of: a plan, a correction, or a stop signal — and nothing else. `advisor` never edits files and never writes anything user-facing.
3. The parent resumes the *same* executor via `SendMessage`, relaying the advisor's guidance. Because the resumed subagent keeps its full context, the parent doesn't re-brief it from scratch.
4. This repeats until the executor finishes the task or `advisor` signals stop.

Consults are capped at **3 per task** by default. If the executor exhausts the cap, it returns its best partial result plus its remaining open questions to the parent, rather than looping forever. The parent stays the DRA throughout and decides whether to accept the final result.

## Are the read-only roles (`planner`, `helper-worker`, `forensic-analyst`, `doc-reviewer`, `reviewer`, `edge-case-analyst`, `advisor`) truly sandboxed?

Mostly by convention plus a coarse tool gate, not a hard sandbox — worth understanding precisely. Each read-only role's `tools:` allowlist withholds `Edit`, `Write`, and `NotebookEdit`, so it cannot mutate files through Claude Code's editing tools. Each role's system prompt also states explicitly that it must not modify files. But most read-only roles keep `Bash` for legitimate inspection (`git diff`, `grep`, reading test output), and `Bash` is a coarse, whole-tool gate — not command-aware — so a role that keeps it could in principle still write to disk via shell redirection. That's a real gap relative to a true read-only sandbox.

Autobots closes that gap in tiers, weakest to strongest: (1) the system-prompt convention above; (2) dropping `Bash` entirely for roles that don't need it; (3) attaching a `hooks.PreToolUse` validator scoped to the subagent that rejects write-shaped shell commands outright. Tier 3 is the only one that's a hard enforcement rather than a convention, and it depends on the package being distributed as files under `.claude/agents/` rather than as a plugin, because Claude Code silently ignores `hooks` for plugin-shipped subagents. As shipped, Autobots relies on tiers 1–2 by default; tier 3 is an optional, deliberate hardening step a project can add.

## Why file-based distribution instead of a plugin?

Claude Code plugins bundle `agents/` and `skills/` behind a marketplace manifest for one-command installation, which is convenient — but plugin subagents **silently ignore `hooks`, `mcpServers`, and `permissionMode`**. Since Autobots' strongest read-only guarantee (the `PreToolUse` write-guard described above) depends on `hooks`, shipping as a plugin would quietly weaken that guarantee with no error to warn you. File-based distribution — copying `SKILL.md` and the ten agent files directly into `.claude/` or `~/.claude/` via `scripts/install.sh` — is the only form where that enforcement can actually run, so it's Autobots' distribution model.

## How do I add or change a role?

Update the role's `.claude/agents/<name>.md` file (frontmatter: `name`, `description`, `model`, `effort` where applicable, `tools`; plus a Markdown body with role responsibility, a non-delegation clause, an access clause for read-only roles, and an output contract), then update `SKILL.md`'s dispatch list, `README.md`'s model-mapping table, the agent list in `scripts/install.sh`, and `docs/design.md`/`docs/spec.md` in the same change. Never grant a new or changed role the `Agent` tool — that invariant is what keeps delegation exactly one level deep. Model, effort, and access-class changes are contract changes: they affect what users can rely on, so they should be deliberate rather than incidental, and the validator (`go run ./scripts/validate_package.go`) checks that all of these files stay mutually consistent before you publish.
