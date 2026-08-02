# Autobots

Autobots is a small, explicit delegation layer for Claude Code: a fixed, named roster of ten subagents — for planning, implementation, review, documentation review, investigation, edge-case analysis, and QA verification — each pinned to a deliberate Claude model tier. It is the Claude Code sibling of [Agenticons](https://github.com/fuentesjr/agenticons), which does the same thing for Codex custom subagents and GPT models. Agenticons routes to `.codex/agents/*.toml`; Autobots routes to `.claude/agents/*.md`. The delegation contract, orchestration model, and validation discipline carry over — only the runtime, spec format, and model roster change.

Autobots does not turn the parent agent into a workflow engine. The parent stays the orchestrator and the DRA (Directly Responsible Agent): it selects the subagent, assigns scope, sequences work, resolves conflicts, verifies results, and treats every subagent output as advisory until it accepts it.

## Opt-in dispatch

Autobots never dispatches on its own. The dispatcher activates only when a user explicitly asks for one of: autobots, subagents, delegation, parallel execution, or model-tier routing. The `/autobots` slash command invokes the same dispatcher.

Escape hatches always win over activation. If a user says any of `no subagents`, `do not use subagents`, `handle locally`, `do this yourself`, or `do not use autobots`, the parent handles the task directly — it does not dispatch, even if the request otherwise looks like an autobots task.

## The roster and model mapping

Every role is pinned to a Claude model tier chosen for task fit: Fable 5 for the roles where errors carry the highest downstream cost (planner, forensic-analyst, advisor — all `xhigh`), Opus 4.8 for high-effort breadth/judgment work (reviewer, edge-case-analyst), Sonnet 5 for execution-heavy work (standard implementation, QA's long tool-call loops, doc-drift's semantic judgment), and Haiku 4.5 for fast, mechanical work. Distribution across the ten roles: **3 Fable · 2 Opus · 3 Sonnet · 2 Haiku**.

| Role | Model alias | Underlying model | Access | Effort |
|---|---|---|---|---|
| `planner` | `fable` | Fable 5 (`claude-fable-5`) | read-only | xhigh |
| `coding-worker` | `sonnet` | Sonnet 5 (`claude-sonnet-5`) | writable | high |
| `fast-coding-worker` | `haiku` | Haiku 4.5 (`claude-haiku-4-5`) | writable | — |
| `helper-worker` | `haiku` | Haiku 4.5 (`claude-haiku-4-5`) | read-only | — |
| `forensic-analyst` | `fable` | Fable 5 (`claude-fable-5`) | read-only | xhigh |
| `doc-reviewer` | `sonnet` | Sonnet 5 (`claude-sonnet-5`) | read-only | medium |
| `reviewer` | `opus` | Opus 4.8 (`claude-opus-4-8`) | read-only | high |
| `qa-engineer` | `sonnet` | Sonnet 5 (`claude-sonnet-5`) | writable | high |
| `edge-case-analyst` | `opus` | Opus 4.8 (`claude-opus-4-8`) | read-only | high |
| `advisor` | `fable` | Fable 5 (`claude-fable-5`) | read-only | xhigh |

Effort is omitted (`—`) on the two Haiku roles because Haiku does not support the `effort` frontmatter field; its depth is the Haiku tier itself. `doc-reviewer` explicitly sets `medium` rather than relying on the `high` default that every other Fable/Opus/Sonnet role would otherwise fall back to.

Only three roles are writable — `coding-worker`, `fast-coding-worker`, `qa-engineer` — and can edit files. The other seven are read-only by construction: their `tools:` allowlist withholds `Edit`, `Write`, and `NotebookEdit`. No role is ever granted the `Agent` tool, so no subagent can spawn another subagent — delegation is exactly one level deep, and every result returns to the parent.

## Caveat: `CLAUDE_CODE_SUBAGENT_MODEL` must be unset

Claude Code resolves a subagent's model in this order, first match wins:

1. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
2. a per-invocation `model` parameter set by the delegating agent
3. the subagent's frontmatter `model:`
4. the main conversation's model

**If `CLAUDE_CODE_SUBAGENT_MODEL` is set, it overrides every role's frontmatter `model:` and collapses the entire ten-role roster onto a single model.** The per-role routing table above — the whole point of Autobots — holds only when this variable is **unset**. This is not a hypothetical edge case: it is easy to have this variable set globally in `~/.claude/settings.json` (for example, to `"sonnet"`) for unrelated reasons and forget it is there.

Before relying on Autobots' model-tier routing:

```bash
echo "$CLAUDE_CODE_SUBAGENT_MODEL"   # should print nothing
unset CLAUDE_CODE_SUBAGENT_MODEL
```

`scripts/install.sh` checks for this variable at install time and warns if it is set, but it cannot unset a variable in your shell for you — you must unset it (or remove it from wherever it's exported) yourself.

## Install

The installer is `scripts/install.sh`. It accepts:

| Flag | Effect |
|---|---|
| `--target <repo>` | Choose the repository to install into. |
| `--global` | Install for the current user under `~/.claude` instead of a repo. |
| `--dry-run` | Preview writes without applying them. |
| `--force` | Overwrite existing files that differ from the shipped versions. |
| `--symlink` | Symlink the skill directory and each agent file to this checkout instead of copying them. Local-checkout mode only — errors in remote installs. |
| `--ref <git-ref>` | When installing remotely, pull from a specific Git ref instead of the default branch. |

It writes the dispatcher skill to `.claude/skills/autobots/SKILL.md` and the ten agent files to `.claude/agents/<name>.md` (or their `~/.claude` equivalents under `--global`).

**From a local checkout:**

```bash
git clone https://github.com/fuentesjr/autobots.git
cd autobots
./scripts/install.sh --target /path/to/your/repo
```

**Remote, via `curl | bash`:**

```bash
curl -fsSL https://raw.githubusercontent.com/fuentesjr/autobots/main/scripts/install.sh | bash -s -- --target /path/to/your/repo
```

Add `--global` to either form to install under `~/.claude` instead of a specific repo. Add `--ref <git-ref>` to the remote form to install from a tag, branch, or commit other than the default.

By default the installer will not overwrite existing files that differ from the shipped versions; pass `--force` to overwrite them, or `--dry-run` first to preview exactly what would be written.

By default the installer copies files, so a target repo (or `--global` install) gets a self-contained snapshot. Pass `--symlink` from a local checkout to link into the checkout instead — `<DEST_ROOT>/skills/autobots` becomes a directory symlink to the checkout's skill directory, and each `<DEST_ROOT>/agents/<name>.md` becomes a symlink to the matching file — so the install tracks the checkout as you edit it, with no reinstall needed. `--symlink` requires a local checkout; it errors in remote (`curl | bash`) installs. Its links are absolute and machine-specific, so it's meant for a maintainer's own live setup (e.g. `--global`), not for a `--target` repo that commits its `.claude/` directory.

**After installing, start a new Claude Code session.** Subagent file changes under `.claude/agents/` are only picked up at session start (unless made live via `/agents`); skill changes under `.claude/skills/` are picked up immediately, but starting fresh ensures the whole roster is loaded consistently.

## Why file-based, not a plugin

Autobots is distributed as files copied directly into `.claude/` (or `~/.claude/`), not as a Claude Code plugin. Claude Code plugins bundle `agents/` and `skills/` behind a marketplace manifest and install with one command, but **plugin subagents silently ignore `hooks`, `mcpServers`, and `permissionMode`**. Autobots' strongest read-only guarantee for `Bash`-bearing roles depends on an optional `hooks.PreToolUse` write-guard, so shipping as a plugin would quietly weaken that guarantee without any error or warning. File-based distribution is the only form in which that enforcement can actually run, so it is the primary — and currently only — distribution unit.

## Patterns

Roles are the primitives; patterns are parent-side recipes for composing them. Autobots ships a small pattern registry:

- **`orchestrator-worker` (default)** — the classic pattern: the parent delegates bounded subtasks to any of the ten roles, receives findings or results back, and synthesizes the final result. This is the default whenever autobots dispatch is triggered and no other pattern is named. Common recipes: plan → implement → review (`planner` → `coding-worker` → `reviewer`); fast fix (`fast-coding-worker`, plus `reviewer` on behavior/API changes); investigate before editing (`helper-worker` → a worker); deep root-cause (`forensic-analyst` → `coding-worker`); documentation drift (`doc-reviewer`); high-stakes review (`reviewer`); exploratory QA (`qa-engineer`); edge-case coverage (`edge-case-analyst`).
- **`advisory`** — triggered by `use the advisor strategy`, `advisory pattern`, or an explicit ask for a cheap executor paired with an advisor. One writable executor (`coding-worker` or `fast-coding-worker`) does the work end-to-end and escalates to `advisor` only at decision points it cannot reasonably resolve; the loop is parent-mediated and capped at 3 consults per task by default.

A request for an unregistered pattern falls back to `orchestrator-worker`, with a note to the user. See `docs/design.md` for the full pattern contract and `docs/faq.md` for a practical walkthrough of the advisory consult loop.

## Further reading

- [`docs/cheatsheet.md`](docs/cheatsheet.md) — quick reference for triggering dispatch, the roster, patterns, and recipes.
- [`docs/design.md`](docs/design.md) — rationale, the full Codex → Claude Code mapping, and open questions.
- [`docs/spec.md`](docs/spec.md) — the normative, buildable contract.
- [`docs/faq.md`](docs/faq.md) — practical Q&A.
