# Autobots Design

## What Autobots Is

Autobots is the Claude Code sibling of [Agenticons](https://github.com/fuentesjr/agenticons). It provides the same small, explicit delegation layer — a fixed, named roster of subagents for planning, implementation, review, documentation review, investigation, and QA verification — but built entirely on Claude Code's native subagent and skill mechanisms and pinned to Claude models only.

Where Agenticons routes to Codex custom subagents (`.codex/agents/*.toml`, GPT models), Autobots routes to Claude Code custom subagents (`.claude/agents/*.md`, Claude models). The delegation contract, orchestration model, and validation discipline are preserved; only the runtime, spec format, and model roster change.

The name keeps the Transformers motif: Agenticons (a portmanteau echoing the villainous Decepticons) is the Codex package; Autobots — the heroic faction — is the Claude package.

## Goal

Give Claude Code users a fixed, explicit set of named subagents they can route to on request, without turning the parent agent into a heavy workflow engine. A user asks for delegation once and gets consistent, named routing through roles such as `planner`, `coding-worker`, `reviewer`, or `doc-reviewer`, each pinned to a deliberate Claude model tier. Delegation follows a named multi-agent pattern: the classic orchestrator/worker pattern is the default, and others — currently the advisory pattern — activate only on explicit request (see Multi-Agent Patterns).

## Non-Goals

- Autobots does not dispatch unless the user explicitly asks for autobots, subagents, delegation, parallel execution, or model-tier routing.
- Autobots does not replace the parent agent's judgment. The parent still owns orchestration, consolidation, and final response quality.
- Autobots does not define project-specific engineering policy. Repository instructions (`CLAUDE.md`) and user requests remain authoritative.
- Autobots does not provide a full reference manual for every Claude Code feature.
- Autobots does not use non-Claude models. Every role is pinned to a Claude model.

## How Autobots Maps Codex → Claude Code

The single most important part of this design is the faithful translation of each Agenticons mechanism onto its Claude Code equivalent. Most map cleanly; two require a deliberate substitution because Claude Code expresses the same intent differently.

| Concern | Agenticons (Codex) | Autobots (Claude Code) |
|---|---|---|
| Runtime | Codex CLI | Claude Code |
| Subagent spec | `.codex/agents/<name>.toml` (TOML) | `.claude/agents/<name>.md` (YAML frontmatter + Markdown body) |
| Skill/dispatcher | `.agents/skills/agenticons/SKILL.md` | `.claude/skills/autobots/SKILL.md` |
| Agent identifier style | `snake_case` (`coding_worker`) | `kebab-case` (`coding-worker`) — Claude Code convention |
| Model field | `model = "gpt-5.5"` (pinned full IDs) | `model: fable` (alias; documented ID mapping) |
| Reasoning depth | `model_reasoning_effort = "low..xhigh"` | `effort: high` frontmatter (same `low..max` scale) — near 1:1 |
| Access control | `sandbox_mode = "read-only" \| "workspace-write"` | `tools:` allowlist (or `disallowedTools:` denylist) — read-only = withhold `Edit`/`Write`/`NotebookEdit` |
| No nested delegation | `max_depth = 1` in `config.toml` | omit `Agent` from every role's `tools` (Claude Code otherwise allows nesting to depth 5) |
| Agent nicknames | `nickname_candidates = [...]` | none — parent-side semantic labels only |
| Role instructions | `developer_instructions = """..."""` | the Markdown body of the agent file |
| Invocation | Codex subagent spawn | `Agent` tool with `subagent_type: <name>`; auto-delegation driven by `description` |
| Dispatcher trigger | "Use agenticons." | "Use autobots." (also the `/autobots` slash command) |

The two substitutions worth reading carefully are **access control** (Access Model) and the **model-routing caveat** below; everything else is a rename or a near-identical field.

> **Note on tool naming.** Claude Code's subagent-dispatch tool is `Agent` (formerly `Task`; the old `Task(...)` permission syntax still works as an alias). It is unrelated to the `TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList` todo-tracking tools, which some agent specs list alongside real tools. Autobots roles grant neither the `Agent` tool (to prevent nested delegation) nor the todo tools (not needed).

## Model Mapping

Autobots uses a **task-fit** mapping: every Claude tier is used for the work it suits best, rather than collapsing all flagship Agenticons roles onto a single model. Fable 5 — the Mythos-class tier above Opus — is reserved for the deepest-reasoning roles (the two `xhigh` analysts and the `advisor`); Opus 4.8 carries the `high`-effort planning, review, and QA roles; Sonnet 5 handles standard implementation; Haiku 4.5 covers fast, mechanical work. The model tier therefore tracks the role's pinned reasoning effort.

| Role | Agenticons model | Claude alias | Claude model |
|---|---|---|---|
| `planner` | `gpt-5.5` | `opus` | Opus 4.8 (`claude-opus-4-8`) |
| `coding-worker` | `gpt-5.3-codex` | `sonnet` | Sonnet 5 (`claude-sonnet-5`) |
| `fast-coding-worker` | `gpt-5.3-codex-spark` | `haiku` | Haiku 4.5 (`claude-haiku-4-5`) |
| `helper-worker` | `gpt-5.4-mini` | `haiku` | Haiku 4.5 (`claude-haiku-4-5`) |
| `forensic-analyst` | `gpt-5.5` | `fable` | Fable 5 (`claude-fable-5`) |
| `doc-reviewer` | `gpt-5.4-mini` | `haiku` | Haiku 4.5 (`claude-haiku-4-5`) |
| `reviewer` | `gpt-5.5` | `opus` | Opus 4.8 (`claude-opus-4-8`) |
| `qa-engineer` | `gpt-5.5` | `opus` | Opus 4.8 (`claude-opus-4-8`) |
| `edge-case-analyst` | `gpt-5.5` | `fable` | Fable 5 (`claude-fable-5`) |
| `advisor` | — (Autobots-only) | `fable` | Fable 5 (`claude-fable-5`) |

Distribution: **3 Fable · 3 Opus · 1 Sonnet · 3 Haiku** (ten roles; `advisor` is an Autobots addition with no Agenticons counterpart — see the advisory pattern in Multi-Agent Patterns).

Specs use the short alias (`fable`/`opus`/`sonnet`/`haiku`) in the `model:` field — this matches the idiom of every real Claude Code agent on disk and lets a role float to Claude Code's current best model for that tier. The exact underlying model is documented here and in `README.md`. Pinning full model IDs (e.g. `claude-fable-5`) is the stricter-reproducibility alternative; it can be adopted later without changing any other part of the contract.

### Model-routing caveat: `CLAUDE_CODE_SUBAGENT_MODEL`

Claude Code resolves a subagent's model in this order (first match wins):

1. `CLAUDE_CODE_SUBAGENT_MODEL` environment variable
2. per-invocation `model` parameter set by the delegating agent
3. the subagent frontmatter `model:`
4. the main conversation's model

**Consequence:** if `CLAUDE_CODE_SUBAGENT_MODEL` is set, it overrides the frontmatter `model:` that Autobots ships, collapsing the whole roster onto one model. This is not a hypothetical edge case: it is easy to have this variable set globally — in `~/.claude/settings.json` or the shell environment (for example, to `"sonnet"`) for unrelated reasons — and forget it is there, in which case every Autobots role would run as that one model regardless of its spec. The package must document that per-role model routing requires `CLAUDE_CODE_SUBAGENT_MODEL` to be **unset**, and the installer/README should surface this prominently (the installer can detect the env var and warn).

## Agent Roles

| Role | Access | Model | Effort | Responsibility |
|---|---|---:|---|---|
| `planner` | read-only | Opus 4.8 | high | Architecture, decomposition, sequencing, risk analysis |
| `coding-worker` | writable | Sonnet 5 | medium | Normal implementation, bug fixes, refactors |
| `fast-coding-worker` | writable | Haiku 4.5 | — | Small localized edits and quick fixes |
| `helper-worker` | read-only | Haiku 4.5 | — | Quick lookup, repo reconnaissance, evidence gathering |
| `forensic-analyst` | read-only | Fable 5 | xhigh | Deep root-cause investigation, intermittent and cross-system failures, forensic reports |
| `doc-reviewer` | read-only | Haiku 4.5 | — | Documentation correctness and drift review |
| `reviewer` | read-only | Opus 4.8 | high | Standard correctness, security, maintainability, regression review |
| `qa-engineer` | writable | Opus 4.8 | high | Exploratory QA verification: exercises changes end-to-end, probes regressions, performance, and user-facing rough edges |
| `edge-case-analyst` | read-only | Fable 5 | xhigh | Edge-case and coverage-gap discovery: finds unconsidered cases and specifies expected behavior and test cases |
| `advisor` | read-only | Fable 5 | xhigh | Guidance-only consultant for the advisory pattern: returns a plan, correction, or stop signal; never edits, never produces user-facing output |

The roles, responsibilities, read-only/writable split, and effort levels are identical to Agenticons — plus one Autobots-only addition, `advisor`, which exists for the advisory pattern and has no Agenticons counterpart; otherwise only the model column and the naming style differ. Effort is `—` for the three Haiku roles because Haiku does not support the `effort` setting (see Reasoning-Depth Translation).

## Agent Spec Contract

Each `.claude/agents/<name>.md` file is YAML frontmatter followed by a Markdown system-prompt body. Autobots uses the following subset of Claude Code's frontmatter fields:

| Field | Req? | Purpose in Autobots |
|---|---|---|
| `name` | Yes | Spawnable identifier. `kebab-case`; must match the filename without `.md`. |
| `description` | Yes | When to use the role. Drives automatic delegation; includes `<example>` trigger blocks. |
| `model` | Yes | `fable`, `opus`, `sonnet`, or `haiku` — the pinned tier for the role. |
| `effort` | Fable/Opus/Sonnet roles | `high`, `xhigh`, etc. — the pinned reasoning effort. Omitted on Haiku roles (unsupported). |
| `tools` | Yes | Explicit allowlist encoding the role's access class. Never includes `Agent`. |
| `color` | No | Optional UI color for the role. |
| system prompt | Yes (body) | Role behavior and output contract — the equivalent of Agenticons' `developer_instructions`. |

Every Autobots role sets `model`, `effort` (where supported), and `tools` explicitly rather than inheriting, because a fixed roster is the whole point: a role must not silently float its model, effort, or access at spawn time. Claude Code offers other optional frontmatter fields (`disallowedTools`, `permissionMode`, `maxTurns`, `isolation`, `memory`, `background`, `skills`, `mcpServers`, `hooks`) that Autobots leaves unset by default; two of them are useful reinforcements and are noted where relevant (`disallowedTools` in Access Model, `isolation: worktree` in Multi-Agent Patterns).

### Example spec (`reviewer`)

```markdown
---
name: reviewer
description: >-
  Use this agent for standard code review — correctness, security,
  maintainability, regressions, and missing tests — including
  security-sensitive and high-stakes review. Examples: <example>...</example>
model: opus
effort: high
color: green
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch
---

You are the standard reviewer subagent. Review like an owner. Do not edit files.
Do not delegate or route; return findings to the parent, who is the orchestrator
and the DRA (Directly Responsible Agent).
...
```

## Access Model

Codex enforces read-only vs writable with a `sandbox_mode` field that the runtime honors even for shell commands. Claude Code has no per-agent sandbox field; access is scoped by the tool list instead. Autobots renders the two Agenticons sandbox modes as two tool profiles:

- **read-only** — `tools: Read, Grep, Glob, Bash, WebFetch, WebSearch`. `Edit`, `Write`, and `NotebookEdit` are withheld, so the agent cannot mutate files through editing tools. `Bash` is granted so review/investigation roles can run read-only inspection (`git diff`, `grep`, targeted test reads). The strictest possible read-only profile — matching the built-in `Explore`/`Plan` agents — is `tools: Read, Grep, Glob` with no shell at all; `doc-reviewer` and `planner` could use it since they need no commands.
- **writable** — the read-only set plus `Edit`, `Write`, and `NotebookEdit`. Equivalently, a role can inherit everything and use `disallowedTools:` to subtract — but Autobots prefers explicit allowlists so a role's capability is legible from its spec.

The access class is therefore **derivable from the `tools` list**: an agent is writable iff its `tools` include `Edit` or `Write`, and read-only otherwise. The validator uses exactly this rule to keep the documented Access column honest (see Validation).

**Fidelity note.** `Bash` is a coarse, whole-tool gate, not a command-aware one: a read-only role that keeps `Bash` can still write to disk via shell redirection, which a Codex `read-only` sandbox would block. Autobots closes this gap in three tiers, weakest to strongest:

1. the role's system prompt states it must not modify files (convention);
2. drop `Bash` from roles that don't need it (`tools: Read, Grep, Glob`);
3. for roles that need `Bash` but must stay read-only, attach a subagent-scoped `hooks.PreToolUse` validator that rejects write-shaped commands (`exit 2`).

Tier 3 is the only mechanism that truly matches a Codex read-only sandbox — and it comes with a distribution constraint: **`hooks` (and `mcpServers`/`permissionMode`) are silently ignored for subagents shipped inside a Claude Code plugin.** They work only for file-based agents under `.claude/agents/` or `~/.claude/agents/`. This is a decisive reason Autobots installs files directly (see Distribution) rather than as a plugin.

## Reasoning-Depth Translation

Agenticons sets a per-agent `model_reasoning_effort` (`low` → `xhigh`). Claude Code has a directly equivalent per-subagent `effort` frontmatter field (`low`/`medium`/`high`/`xhigh`/`max`), so the mapping is near 1:1 — a genuine field, not a prompt workaround.

Two caveats shape the rendering:

- **Haiku has no effort support.** The `effort` setting applies to Fable 5, Sonnet 5, and Opus 4.x; Haiku ignores it. So the three Haiku roles (`fast-coding-worker`, `helper-worker`, `doc-reviewer`) omit `effort` entirely — their depth is the Haiku tier itself, which is the correct floor for `low`/`medium` mechanical work anyway.
- **Default effort is `high`.** A role that omits `effort` on a Fable/Opus/Sonnet model still runs at `high`. Autobots therefore sets `effort` explicitly on every Fable/Opus/Sonnet role to encode the contract rather than lean on a default — including `coding-worker: medium`, which must be explicit to avoid silently running `high`.

| Role | Agenticons `model_reasoning_effort` | Autobots `effort:` |
|---|---|---|
| `fast-coding-worker` | `low` | (omitted — Haiku) |
| `helper-worker` | `medium` | (omitted — Haiku) |
| `doc-reviewer` | `medium` | (omitted — Haiku) |
| `coding-worker` | `medium` | `medium` |
| `planner` | `high` | `high` |
| `reviewer` | `high` | `high` |
| `qa-engineer` | `high` | `high` |
| `forensic-analyst` | `xhigh` | `xhigh` |
| `edge-case-analyst` | `xhigh` | `xhigh` |
| `advisor` | — (Autobots-only) | `xhigh` |

The `ultrathink` keyword (recognized anywhere in a prompt body) remains available as a per-turn reinforcement for the deepest roles, and the user's session `/effort` still applies on top; neither is required, since `effort:` carries the contract.

## Dispatch Contract

Dispatch is opt-in. The skill should activate when the user explicitly asks for autobots, subagents, delegation, parallel execution, or model-tier routing. Because a Claude Code skill is also a slash command (named after its directory), `/autobots` is an explicit way to invoke the same dispatcher.

Escape hatches take precedence. If the user says `no subagents`, `do not use subagents`, `handle locally`, `do this yourself`, or `do not use autobots`, the parent agent handles the task directly.

Pattern selection is part of dispatch. Delegation uses the default `orchestrator-worker` pattern unless the user names another registered pattern by its triggers (see the registry in Multi-Agent Patterns). A request for an unregistered pattern falls back to the default, with a note to the user.

Model routing is part of the package contract. The parent must spawn each role with the model pinned in its `.claude/agents/<name>.md` spec and documented in the Model Mapping table; it must not override a role to an unlisted model at dispatch time. Model changes happen by editing the spec and docs, never ad hoc. (This contract holds only when `CLAUDE_CODE_SUBAGENT_MODEL` is unset — see the Model-routing caveat.)

Fixing one model per role also keeps each subagent cache-coherent by construction: a role never switches models mid-task, so its prompt-prefix cache is never invalidated by a routing change. Dynamic auto-routers add cache-aware machinery to recover this property; a fixed roster has it for free.

## Parent Orchestration Contract

The parent agent is the orchestrator and DRA (Directly Responsible Agent). DRA means the parent remains accountable for the project outcome rather than handing accountability to subagents. It remains responsible for:

- selecting the right subagent
- assigning concrete scope and constraints
- sequencing work and deciding when to stop or continue
- assigning disjoint ownership for parallel writable work
- resolving conflicts between subagent outputs
- verifying results and deciding which findings or patches to accept
- treating subagent output as advisory until the parent accepts it
- consolidating results, conflicts, verification, and remaining risks into the final response

Subagents must not delegate or route. Claude Code allows nested subagents (to a fixed depth of 5), so this rule is not automatic — Autobots enforces it by **omitting the `Agent` tool from every role's `tools` allowlist**. Without `Agent`, a role cannot spawn anything; findings and results always return to the parent, who remains accountable.

## Multi-Agent Patterns

Roles are the primitives; patterns are parent-side recipes for composing them. Autobots ships a small registry of named patterns: the classic orchestrator/worker pattern is the default, and others activate only when the user names them. Pattern-specific protocol lives in the parent's dispatch prompts, never in the agent specs — specs stay pattern-agnostic, so adding a pattern never changes a role's contract.

### Pattern contract

Every pattern — current and future — must satisfy the package invariants:

- dispatch is opt-in and escape hatches win (Dispatch Contract)
- delegation is exactly one level deep; no role is granted the `Agent` tool
- the parent is the orchestrator and DRA; subagent output is advisory until the parent accepts it
- every role keeps its pinned model, effort, and access class
- parallel writable work uses disjoint ownership (or `isolation: worktree`)

Patterns that cannot satisfy the contract — true peer-to-peer topologies, dynamically created roles — are out of scope by design, not merely unimplemented. Deterministic heavy fan-out (scripted control flow over dozens of agents) is better served by a workflow engine and stays a non-goal.

### Registry

Each pattern is documented with the same shape — name, triggers, roles used, flow, bounds — so adding one is a new registry entry plus a subsection, never a redesign.

| Pattern | Triggers | Roles used |
|---|---|---|
| `orchestrator-worker` (default) | any autobots dispatch that names no other pattern | all roles |
| `advisory` | "use the advisor strategy", "advisory pattern", an explicit ask for a cheap executor with an advisor | one writable executor (`coding-worker` or `fast-coding-worker`) + `advisor` |

### `orchestrator-worker` (default)

Autobots keeps orchestration shallow. The parent delegates bounded subtasks, receives findings/results back, and synthesizes the result. Common recipes (identical to Agenticons, retargeted to the kebab-case names):

- Plan then implement: `planner` → `coding-worker` → `reviewer`
- Fast fix: `fast-coding-worker`, with `reviewer` when behavior or public API changes
- Investigation before editing: `helper-worker` → `coding-worker` or `fast-coding-worker`
- Deep root-cause investigation: `forensic-analyst` → `coding-worker` once a cause is confirmed; the parent saves the accepted report to a file when the user requests it
- Documentation drift review: `doc-reviewer`
- High-stakes or security-sensitive review: `reviewer`
- Exploratory QA verification: `qa-engineer` after a feature lands or before a release; it exercises the change rather than reading it, and the parent routes confirmed findings to `coding-worker` or `fast-coding-worker`
- Edge-case and coverage analysis: `edge-case-analyst` returns a report of uncovered cases with proposed specs and concrete test cases; the parent saves the report when the user requests it and routes confirmed cases to `coding-worker` or `fast-coding-worker`

Parallel writable work uses disjoint ownership. Where two writable workers might otherwise collide, the parent can additionally spawn them with `isolation: worktree`, which runs each in its own git worktree — a stronger guarantee than ownership-by-convention. Parallel review work uses distinct review angles such as correctness, security, and regression risk.

### `advisory`

The [advisory pattern](https://claude.com/blog/the-advisor-strategy) inverts the default: a cost-effective executor drives the whole task end-to-end and escalates to a stronger model only at decision points it cannot reasonably resolve. The advisor never edits files and never produces user-facing output — it returns a plan, a correction, or a stop signal, and the executor resumes. The pattern trades peak capability for cost; Anthropic reports Sonnet with an Opus advisor scoring 2.7 percentage points higher on SWE-bench Multilingual than Sonnet alone at 11.9% lower cost per task.

**Roles.** One writable executor — `coding-worker` (Sonnet) for normal work, or `fast-coding-worker` (Haiku) for maximum cost reduction — plus the read-only `advisor` role (Fable 5, `xhigh`).

**Flow (parent-mediated).**

1. The parent spawns the executor with the task plus a consult protocol appended to the dispatch prompt: work autonomously; when blocked on a decision you cannot reasonably resolve, stop and return a structured consult request — the question, the options considered, and pointers to the relevant files and evidence.
2. The parent forwards the consult request and scope to `advisor`, which returns a plan, a correction, or a stop signal.
3. The parent resumes the *same* executor via `SendMessage`, relaying the guidance. Resumed subagents retain their full context, so the loop is stateful — no re-briefing.
4. Repeat until the executor completes or the advisor signals stop. The parent remains DRA and accepts or rejects the result as usual.

**Bounds.** The dispatch prompt caps consults per task (default: 3), mirroring the API advisor's `max_uses`. On exhaustion the executor returns its best partial result and remaining open questions to the parent.

**Why parent-mediated.** Executors cannot consult the advisor directly: the type-restricted `Agent(advisor)` allowlist syntax is ignored when an agent runs *as* a subagent, so granting `Agent` would be all-or-nothing and break the depth-1 invariant. Routing consults through the parent preserves the pattern contract at the cost of one round-trip per consult.

**Native fast path.** Claude Code (v2.1.98+, Anthropic API only) also exposes the API's advisor tool natively at session level — `/advisor`, `advisorModel` in `settings.json`, or `--advisor` at launch. Subagents inherit the session advisor, so with it set, executors escalate mid-task inside a single request with no parent round-trips. But it is session-global (it applies to the parent and every subagent; there is no per-subagent `advisor:` frontmatter), and setting it is a user action the skill may suggest but must not perform. The parent-mediated flow above is the portable form and the only per-task-scoped one.

### User-facing labels

Claude Code has no agent nickname system, so Autobots drops Agenticons' `nickname_candidates` field. The semantic-label convention is still valuable and is preserved as a parent-side practice: in user-facing updates, refer to each spawned subagent as `<role>: <task or scope>` (for example `helper-worker: dependency readiness review`) so readers can tell what each agent owned. Any tool-generated agent id is traceability metadata only.

## Distribution

Two Claude Code distribution units are available; Autobots deliberately chooses the first:

- **File-based (chosen).** `SKILL.md` and the ten agent `.md` files are copied directly into `.claude/skills/autobots/` and `.claude/agents/` (or their `~/.claude` equivalents), exactly mirroring how Agenticons ships. This keeps `scripts/install.sh` as the single distribution path and — critically — is the only form in which the optional `hooks.PreToolUse` read-only enforcement (Access Model, tier 3) actually runs.
- **Plugin (not chosen).** Claude Code plugins bundle `agents/` + `skills/` with a marketplace manifest and install via `/plugin install <name>@<marketplace>`. Plugins give automatic namespacing (`autobots:reviewer`) and one-command installation, but plugin subagents **silently ignore** `hooks`, `mcpServers`, and `permissionMode`. Because Autobots' strongest read-only guarantee depends on `hooks`, the plugin form would quietly weaken it. A plugin distribution can be added later as a convenience, documented as not supporting hook-enforced read-only.

## Validation

`scripts/validate_package.go` protects the package contract before publishing or installation, mirroring the Agenticons validator but retargeted to Markdown-frontmatter specs. It parses YAML frontmatter (splitting the `---` fenced block from the Markdown body) instead of TOML — the one dependency change is `github.com/BurntSushi/toml` → `gopkg.in/yaml.v3`.

It checks:

- every `.claude/agents/*.md` file has a parseable YAML frontmatter block and a non-empty system-prompt body
- required frontmatter fields are present and non-blank: `name`, `description`, `model`, `tools`
- each agent's `name` matches its filename and names are unique
- `model` is one of the supported aliases (`fable`, `opus`, `sonnet`, `haiku`)
- `effort`, when present, is one of `low`/`medium`/`high`/`xhigh`/`max`, and is **absent on Haiku roles** (where it is inert)
- `tools` is well-formed and **never contains `Agent`** (enforcing non-delegation), and the **derived access class** (writable iff `tools` includes `Edit` or `Write`) matches the Access column in `docs/design.md`
- `README.md`, `SKILL.md`, `docs/design.md`, `docs/faq.md`, and `docs/cheatsheet.md` mention every configured agent as a standalone identifier (a mention embedded in a longer role name, such as `reviewer` inside `doc-reviewer`, does not count)
- `README.md`, `docs/design.md`, and `docs/cheatsheet.md` document each agent with its configured model on one line
- `SKILL.md`'s exact dispatch list matches the agent files
- the pattern registries in `SKILL.md`, `docs/design.md`, and `docs/cheatsheet.md` list the same pattern names, and every role a pattern references exists as an agent file
- `scripts/install.sh`'s agent list matches the agent files
- deprecated project identifiers do not remain in primary docs
- the on-disk roster matches the normative table in `docs/spec.md` §3 exactly — the same ten role names and, per role, the pinned model, effort, and access class — so the roster cannot drift from the spec even if every doc is updated to match the drifted files

Run validation and tests with:

```bash
go run ./scripts/validate_package.go
go test ./...
go vet ./...
```

`.github/workflows/validate.yml` runs all three on every push and pull request.

The conceptual changes from Agenticons are (1) the access check validates a *derived* access class from the presence of editing tools rather than a literal `sandbox_mode` string, and (2) two new checks — `effort` validity and the `Agent`-exclusion rule — encode invariants that are implicit in Claude Code's model rather than declared by a single field.

## Installation Script

`scripts/install.sh` is the primary distribution path and keeps the Agenticons flag surface unchanged:

- `--target <repo>` to choose the repository to install into
- `--global` to install for the current user under `~/.claude`
- `--dry-run` to preview writes
- `--force` to overwrite differing files
- `--ref <git-ref>` for remote installs from a specific Git ref

Only the destination paths change:

| Artifact | Repo-local destination | Global destination |
|---|---|---|
| Skill | `.claude/skills/autobots/SKILL.md` | `~/.claude/skills/autobots/SKILL.md` |
| Agents | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` |

The script works from a local checkout and through a raw GitHub pipe, where it downloads `SKILL.md` and `.claude/agents/*.md` from the selected ref. It should additionally warn when `CLAUDE_CODE_SUBAGENT_MODEL` is set in the environment, since that silently overrides the per-role model routing (see the Model-routing caveat). After install it advises the user to start a new Claude Code session so the skill and agents are picked up (subagent file edits require a session restart unless made via `/agents`; skill edits are picked up live).

## Configuration

Codex caps fan-out with `[agents] max_threads` / `max_depth` in `config.toml`. Claude Code expresses the same two intents differently:

- **Depth** is enforced by capability, not a number: because no Autobots role is granted the `Agent` tool, no role can spawn a nested subagent, so delegation is exactly one level deep. This replaces `max_depth = 1`.
- **Breadth** is controlled by the parent's fan-out discipline — how many subagents it spawns for a task — and by Claude Code's internal cap on concurrently running subagents.

Project-level knobs — `Bash` deny rules for hard read-only enforcement, permission `allow`/`deny` rules, and the `CLAUDE_CODE_SUBAGENT_MODEL` caveat — live in `.claude/settings.json` and the environment rather than a package config file.

## Change Policy

When adding, removing, or renaming an agent, update the agent `.md` file, `SKILL.md`, `README.md`, the agent list in `scripts/install.sh`, and any relevant docs in the same change. Run the validator and tests before publishing.

Model, effort, access (tool profile), and role changes should be deliberate because they affect the delegation contract users rely on. Because access class is derived from `tools`, changing a role's tool list is a contract change and must update the design.md Access column too.

Patterns are part of the delegation contract as well. Adding or changing a pattern updates the registry in both `SKILL.md` and `docs/design.md` in the same change; a new pattern must satisfy the pattern contract (Multi-Agent Patterns) and may only reference roles that exist as agent files.

## Differences from Agenticons (Summary)

1. **Runtime**: Codex → Claude Code.
2. **Spec format**: `.codex/agents/*.toml` → `.claude/agents/*.md` (YAML frontmatter + Markdown body).
3. **Skill path**: `.agents/skills/agenticons/` → `.claude/skills/autobots/`; the dispatcher is also the `/autobots` slash command.
4. **Names**: `snake_case` → `kebab-case`.
5. **Models**: GPT tiers → Claude tiers, task-fit (3 Fable · 3 Opus · 1 Sonnet · 3 Haiku, with the model tier tracking each role's reasoning effort). Subject to the `CLAUDE_CODE_SUBAGENT_MODEL` override caveat.
6. **Reasoning effort**: `model_reasoning_effort` field → Claude Code's per-subagent `effort:` field (near 1:1), omitted on the three Haiku roles because Haiku ignores it.
7. **Access control**: `sandbox_mode` field → `tools` allowlist (writable iff `Edit`/`Write` present). Shell-level write prevention needs a `PreToolUse` hook, which is why Autobots ships file-based rather than as a plugin.
8. **No nested delegation**: `max_depth = 1` → omit the `Agent` tool from every role.
9. **Nicknames**: `nickname_candidates` dropped; semantic labels remain a parent-side convention.
10. **Validator**: TOML parser → YAML-frontmatter parser; literal sandbox check → derived access-class check, plus new `effort`-validity, `Agent`-exclusion, and pattern-registry checks.
11. **Patterns**: Agenticons has a single implicit orchestrator/worker flow; Autobots names it in a pattern registry governed by an explicit pattern contract, adds the opt-in `advisory` pattern, and adds the Autobots-only `advisor` role to support it.
12. **Everything else** — the opt-in dispatch contract, escape hatches, DRA orchestration model, the original roster of nine roles, and the default dispatch recipes — is preserved unchanged.

## Open Questions

These do not block the design; they are the remaining choices to settle during implementation.

- **Alias vs pinned model ID.** Recommendation is aliases (`fable`/`opus`/`sonnet`/`haiku`) with the documented ID mapping; revisit if strict reproducibility/pinning is required.
- **Strict read-only for `reviewer`/`forensic-analyst`/`edge-case-analyst`.** These keep `Bash` for inspection. Decide whether the convention + prompt discipline is sufficient, or whether to ship the `PreToolUse` write-guard hook (tier 3) for hard enforcement — which also commits the package to file-based (non-plugin) distribution.
- **Optional plugin distribution.** Whether to additionally publish a plugin form for one-command install, documented as not supporting hook-enforced read-only.
- **Subagent concurrency knob.** Whether a `.claude/settings.json` key exposes a user-tunable cap on concurrent subagents, or whether breadth stays purely parent-controlled + internally capped. To confirm during implementation.
- **Advisory consult cap.** The default of 3 consults per task is a starting point; tune against real tasks during implementation.
- **`advisor` tool profile.** Ships with the standard read-only profile (keeps `Bash` for inspection); decide whether the strict no-shell profile (`Read, Grep, Glob`) suffices, since the parent already passes evidence in the consult request.
- **Native advisor guidance.** Whether README should recommend setting the session-level `advisorModel` when on the Anthropic API — faster than the parent-mediated loop, but session-global and user-controlled.
