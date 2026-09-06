# Autobots

Autobots is a small, explicit delegation layer for Claude Code: a fixed, named roster of ten subagents — for planning, implementation, review, documentation review, investigation, edge-case analysis, and QA verification — each pinned to a deliberate Claude model tier. It is the Claude Code sibling of [Agenticons](https://github.com/fuentesjr/agenticons), which does the same thing for Codex custom subagents and GPT models. Agenticons routes to `.codex/agents/*.toml`; Autobots routes to `.claude/agents/*.md`. The delegation contract, orchestration model, and validation discipline carry over — only the runtime, spec format, and model roster change.

Autobots does not turn the parent agent into a workflow engine. The parent stays the orchestrator and the DRA (Directly Responsible Agent): it selects the subagent, assigns scope, sequences work, resolves conflicts, verifies results, and treats every subagent output as advisory until it accepts it.

## Opt-in dispatch

Autobots never dispatches on its own. The dispatcher activates only when a user explicitly asks for one of: autobots, subagents, delegation, parallel execution, or model-tier routing. The `/autobots` slash command invokes the same dispatcher.

Escape hatches always win over activation. If a user says any of `no subagents`, `do not use subagents`, `handle locally`, `do this yourself`, or `do not use autobots`, the parent handles the task directly — it does not dispatch, even if the request otherwise looks like an autobots task.

## The roster and model mapping

Every role is pinned to a Claude model family chosen for task fit, with quality first and speed second. Roles whose output gates correctness run on Fable with deep reasoning: `planner`, `forensic-analyst`, `advisor`, and `edge-case-analyst` at `xhigh`, and `reviewer` at `high` (it runs after every change, and `high` keeps its findings precise rather than speculative). Roles that write code run a big model at `low` effort — Fable for `coding-worker`, Opus for `fast-coding-worker` — because higher effort makes implementers produce more code for the same functionality, while a stronger model makes fewer botched edits. Opus at `high` carries the judgment-heavy execution roles: `qa-engineer`'s long tool-call loops and `doc-reviewer`'s semantic drift checks. Sonnet at `low` is reserved for `helper-worker`, where turn speed is the deliverable. Distribution across the ten roles: **6 Fable · 3 Opus · 1 Sonnet · 0 Haiku**.

| Role | Model (alias → resolves to) | Access | Effort |
|---|---|---|---|
| `planner` | `fable` → Fable 5.1 | read-only | xhigh |
| `coding-worker` | `fable` → Fable 5.1 | writable | low |
| `fast-coding-worker` | `opus` → Opus 5 | writable | low |
| `helper-worker` | `sonnet` → Sonnet 5 | read-only | low |
| `forensic-analyst` | `fable` → Fable 5.1 | read-only | xhigh |
| `doc-reviewer` | `opus` → Opus 5 | read-only | high |
| `reviewer` | `fable` → Fable 5.1 | read-only | high |
| `qa-engineer` | `opus` → Opus 5 | writable | high |
| `edge-case-analyst` | `fable` → Fable 5.1 | read-only | xhigh |
| `advisor` | `fable` → Fable 5.1 | read-only | xhigh |

Each role's `model:` is a family alias (`fable`, `opus`, `sonnet`), not a versioned ID, so a role always runs the newest model Claude Code knows for that family: when a new Fable ships and Claude Code re-points the alias, every Fable role moves with it, with no roster edit. The "resolves to" column is what those aliases mean on Claude Code 2.1.255 or later (before 2.1.255, `fable` meant Fable 5). Two things can make an alias resolve to something else: an older Claude Code build, and an `ANTHROPIC_DEFAULT_FABLE_MODEL`/`_OPUS_MODEL`/`_SONNET_MODEL` environment variable, which redirects the alias outright. The installer warns on both. Every role also sets `effort` explicitly rather than inheriting the session's effort level. No role runs on Haiku.

Only three roles are writable — `coding-worker`, `fast-coding-worker`, `qa-engineer` — and can edit files. The other seven are read-only by construction: their `tools:` allowlist withholds `Edit`, `Write`, and `NotebookEdit`. No role is ever granted the `Agent` tool, so no subagent can spawn another subagent — delegation is exactly one level deep, and every result returns to the parent.

## Caveat: `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` must be unset

Claude Code resolves a subagent's model in this order, first match wins:

1. a per-invocation `model` parameter set by the delegating agent
2. the subagent's frontmatter `model:`
3. the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
4. the main conversation's model

Autobots pins every role at step 2, so `CLAUDE_CODE_SUBAGENT_MODEL` on its own does not touch the roster — it is only a default for subagents that declare no model. **`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` is different: it makes Claude Code ignore the `model:` field of every subagent definition and run them all on `CLAUDE_CODE_SUBAGENT_MODEL` (or on the main conversation's model when that is unset), collapsing the entire ten-role roster onto a single model.** The per-role routing table above — the whole point of Autobots — holds only when `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is **unset**. It is easy to have it set globally in `~/.claude/settings.json` for unrelated reasons and forget it is there.

Before relying on Autobots' model-tier routing:

```bash
echo "$CLAUDE_CODE_SUBAGENT_MODEL_FORCE"   # should print nothing
unset CLAUDE_CODE_SUBAGENT_MODEL_FORCE
```

`scripts/install.sh` checks for this variable at install time and warns if it is set, but it cannot unset a variable in your shell for you — you must unset it (or remove it from wherever it's exported) yourself. Before Claude Code v2.1.251, `CLAUDE_CODE_SUBAGENT_MODEL` itself came first in the order above and overrode frontmatter; on those versions, unset it too.

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


## Relationship to Optimites (fork loop)

**Autobots is the canonical fork** for the shared dispatcher contract (SKL/ADV sections, roster role semantics, pattern registry). [Optimites](https://github.com/fuentesjr/optimites) is the Grok Build port. Before editing shared behavior in either repo, run:

```bash
./scripts/fork-diff.sh
# or: OPTIMITES_ROOT=/path/to/optimites ./scripts/fork-diff.sh
```

Port intentional shared changes into Autobots first, then into Optimites. Platform-specific tool names, model pins, and install paths are expected to differ.

## Further reading

- [`docs/cheatsheet.md`](docs/cheatsheet.md) — quick reference for triggering dispatch, the roster, patterns, and recipes.
- [`docs/design.md`](docs/design.md) — rationale, the full Codex → Claude Code mapping, and open questions.
- [`docs/spec.md`](docs/spec.md) — the normative, buildable contract.
- [`docs/faq.md`](docs/faq.md) — practical Q&A.
