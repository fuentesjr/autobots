# Autobots Implementation Specification

This document is the **normative, buildable contract** for the Autobots package. It is derived from [`docs/design.md`](./design.md); the design doc carries the rationale and history ("why"), while this spec states "what, exactly." Where the two disagree, this spec governs implementation; discrepancies should be reconciled back into the design doc.

## 1. Conventions

- Requirement keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used per [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).
- Every normative statement is numbered with a stable prefix so tests and the validator can cite it: `ART-*` (artifacts), `AGT-*` (agents), `MDL-*` (model routing), `SKL-*` (skill/dispatch), `PAT-*` (patterns), `ADV-*` (advisory protocol), `VAL-*` (validator), `INS-*` (installer), `ACC-*` (acceptance).
- Role names are `kebab-case`. Identifiers, field names, tool names, and file paths are `backticked`.
- Statements marked **[Deferred]** correspond to an Open Question in `docs/design.md` that this spec deliberately does not resolve. Implementations MUST NOT treat a Deferred item as settled; they MUST ship the stated default (if any) and leave the decision open.

## 2. Artifact Inventory

### 2.1 Shipped files

`ART-1` The package MUST ship exactly these artifacts and no others as part of the delegation contract:

| Artifact | Repo-local path | Global path (`--global`) | Required content |
|---|---|---|---|
| Dispatcher skill | `.claude/skills/autobots/SKILL.md` | `~/.claude/skills/autobots/SKILL.md` | §6–§8 |
| `planner` agent | `.claude/agents/planner.md` | `~/.claude/agents/planner.md` | §4 |
| `coding-worker` agent | `.claude/agents/coding-worker.md` | `~/.claude/agents/coding-worker.md` | §4 |
| `fast-coding-worker` agent | `.claude/agents/fast-coding-worker.md` | `~/.claude/agents/fast-coding-worker.md` | §4 |
| `helper-worker` agent | `.claude/agents/helper-worker.md` | `~/.claude/agents/helper-worker.md` | §4 |
| `forensic-analyst` agent | `.claude/agents/forensic-analyst.md` | `~/.claude/agents/forensic-analyst.md` | §4 |
| `doc-reviewer` agent | `.claude/agents/doc-reviewer.md` | `~/.claude/agents/doc-reviewer.md` | §4 |
| `reviewer` agent | `.claude/agents/reviewer.md` | `~/.claude/agents/reviewer.md` | §4 |
| `qa-engineer` agent | `.claude/agents/qa-engineer.md` | `~/.claude/agents/qa-engineer.md` | §4 |
| `edge-case-analyst` agent | `.claude/agents/edge-case-analyst.md` | `~/.claude/agents/edge-case-analyst.md` | §4 |
| `advisor` agent | `.claude/agents/advisor.md` | `~/.claude/agents/advisor.md` | §4 |

`ART-2` The package MUST include these supporting (non-installed) files in the repository:

| File | Purpose | Referenced by |
|---|---|---|
| `scripts/install.sh` | Installer (§10) | `INS-*` |
| `scripts/validate_package.go` | Validator (§9) | `VAL-*` |
| `docs/design.md` | Rationale document | `VAL-6`, `VAL-7`, `VAL-8`, `VAL-10` |
| `docs/spec.md` | This document | `VAL-14` (§3 roster table) |
| `docs/faq.md` | User FAQ | `VAL-7`, `VAL-12` |
| `docs/cheatsheet.md` | Usage cheatsheet | `VAL-7`, `VAL-8`, `VAL-10`, `VAL-12` |
| `README.md` | Overview + model mapping + `CLAUDE_CODE_SUBAGENT_MODEL` caveat | `VAL-7`, `VAL-8`, `VAL-12`, `MDL-3` |
| `.github/workflows/validate.yml` | CI running the acceptance commands (§11) | `ACC-4` |

`ART-3` There MUST be exactly ten agent files under `.claude/agents/`, one per role in §3. The installer, `SKILL.md`, `README.md`, `docs/design.md`, `docs/faq.md`, and `docs/cheatsheet.md` MUST reference the same ten role names (enforced by `VAL-7`, `VAL-9`, `VAL-11`, `VAL-14`).

`ART-4` The package MUST be distributed **file-based** (copied directly into `.claude/` or `~/.claude/`), MUST NOT be shipped as a Claude Code plugin as the primary distribution unit, because plugin subagents silently ignore `hooks`, `mcpServers`, and `permissionMode`. **[Deferred]** An additional plugin distribution MAY be published later, documented as not supporting hook-enforced read-only.

## 3. Agent Roster

`AGT-1` The roster MUST be exactly these ten roles with exactly these attributes:

| Role | Access | `model` alias | `effort` | Underlying model |
|---|---|---|---|---|
| `planner` | read-only | `fable` | `xhigh` | Fable 5 (`claude-fable-5`) |
| `coding-worker` | writable | `sonnet` | `high` | Sonnet 5 (`claude-sonnet-5`) |
| `fast-coding-worker` | writable | `haiku` | *(omitted)* | Haiku 4.5 (`claude-haiku-4-5`) |
| `helper-worker` | read-only | `haiku` | *(omitted)* | Haiku 4.5 (`claude-haiku-4-5`) |
| `forensic-analyst` | read-only | `fable` | `xhigh` | Fable 5 (`claude-fable-5`) |
| `doc-reviewer` | read-only | `sonnet` | `medium` | Sonnet 5 (`claude-sonnet-5`) |
| `reviewer` | read-only | `opus` | `high` | Opus 4.8 (`claude-opus-4-8`) |
| `qa-engineer` | writable | `sonnet` | `high` | Sonnet 5 (`claude-sonnet-5`) |
| `edge-case-analyst` | read-only | `opus` | `high` | Opus 4.8 (`claude-opus-4-8`) |
| `advisor` | read-only | `fable` | `xhigh` | Fable 5 (`claude-fable-5`) |

`AGT-2` Model distribution MUST be **3 Fable** (`planner`, `forensic-analyst`, `advisor`) · **2 Opus** (`reviewer`, `edge-case-analyst`) · **3 Sonnet** (`coding-worker`, `doc-reviewer`, `qa-engineer`) · **2 Haiku** (`fast-coding-worker`, `helper-worker`).

`AGT-3` Exactly three roles MUST be writable: `coding-worker`, `fast-coding-worker`, `qa-engineer`. All other seven roles MUST be read-only.

## 4. Per-Agent Spec Contract

### 4.1 File shape

`AGT-4` Each agent file MUST consist of a single YAML frontmatter block delimited by `---` fences, immediately followed by a non-empty Markdown system-prompt body.

`AGT-5` The frontmatter MUST set these fields explicitly (no inheritance):

| Field | Requirement |
|---|---|
| `name` | MUST be present, `kebab-case`, and equal to the filename without `.md`. MUST be unique across the roster. |
| `description` | MUST be present and non-blank. MUST describe when to route to the role and SHOULD include one or more `<example>` trigger blocks that drive automatic delegation. |
| `model` | MUST be present and MUST be one of `fable`, `opus`, `sonnet`, `haiku`, matching §3 for the role. |
| `effort` | MUST be present on every Fable/Opus/Sonnet role with the value in §3. MUST be omitted on every Haiku role (`fast-coding-worker`, `helper-worker`). |
| `tools` | MUST be present and MUST be exactly the access-class list in §4.2. MUST NOT contain `Agent`. MUST NOT contain any todo tool (`TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`). |
| `color` | MAY be present (optional UI color). |

`AGT-6` Agent frontmatter SHOULD NOT set the other optional Claude Code fields (`disallowedTools`, `permissionMode`, `maxTurns`, `isolation`, `memory`, `background`, `skills`, `mcpServers`, `hooks`) by default. **[Deferred]** A `hooks.PreToolUse` write-guard MAY be attached to read-only roles that retain `Bash` (`reviewer`, `forensic-analyst`, `edge-case-analyst`, `advisor`) for hard shell-level read-only enforcement; this decision is an Open Question and this spec does not require it.

### 4.2 Tool lists (access classes)

`AGT-7` Read-only roles (`planner`, `helper-worker`, `forensic-analyst`, `doc-reviewer`, `reviewer`, `edge-case-analyst`, `advisor`) MUST set:

```
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch
```

`AGT-8` Writable roles (`coding-worker`, `fast-coding-worker`, `qa-engineer`) MUST set the read-only list plus the editing tools:

```
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch, Edit, Write, NotebookEdit
```

`AGT-9` The access class MUST be derivable from `tools` alone: a role is **writable iff its `tools` include `Edit` or `Write`**, and read-only otherwise. This derived class MUST match the Access column in §3 and in `docs/design.md`.

`AGT-10` No role's `tools` list MUST contain `Agent` (nested-delegation prohibition, §6). **[Deferred]** The strict no-shell read-only profile (`Read, Grep, Glob`) for `doc-reviewer`, `planner`, and/or `advisor` is an Open Question; this spec requires the standard read-only profile in `AGT-7` unless and until that question is resolved.

### 4.3 System-prompt body

`AGT-11` Each role's Markdown body MUST contain, at minimum:

1. **Role responsibility** — a statement of the role's scope matching the Responsibility column of the design's Agent Roles table (e.g. `planner`: architecture, decomposition, sequencing, risk analysis).
2. **Non-delegation clause** — an explicit statement that the role MUST NOT delegate, route, or spawn other agents, and that it returns findings/results to the parent, who is the orchestrator and DRA (Directly Responsible Agent).
3. **Access clause** — for read-only roles, an explicit statement that the role MUST NOT modify files (convention-tier enforcement reinforcing the tool allowlist).
4. **Output contract** — the structured form the role returns to the parent (findings list, report, patch summary, plan, etc.), appropriate to the role.

`AGT-12` Per-role body requirements (in addition to `AGT-11`):

| Role | Output contract MUST specify |
|---|---|
| `planner` | A plan: decomposition, sequencing, risks; no file edits. |
| `coding-worker` | Implementation with a summary of changes made; normal-scope edits. |
| `fast-coding-worker` | Small, localized edits with a change summary. |
| `helper-worker` | Reconnaissance/evidence findings; no edits. |
| `forensic-analyst` | A forensic root-cause report; no edits. |
| `doc-reviewer` | Documentation correctness/drift findings; no edits. |
| `reviewer` | Review findings (correctness, security, maintainability, regressions, missing tests); no edits. |
| `qa-engineer` | Results of exercising the change end-to-end (regressions, performance, UX rough edges); it MAY edit to run/scaffold verification but returns findings to the parent. |
| `edge-case-analyst` | A report of uncovered cases with proposed specs and concrete test cases; no edits. |
| `advisor` | Guidance only — exactly one of a **plan**, a **correction**, or a **stop** signal (see §6); MUST NOT edit files and MUST NOT produce user-facing output. |

## 5. Model Routing

`MDL-1` Each role MUST be pinned to the `model` alias in §3 via its frontmatter. Specs MUST use the short alias (`fable`/`opus`/`sonnet`/`haiku`), not a full model ID. **[Deferred]** Pinning full model IDs (e.g. `claude-fable-5`) is the stricter-reproducibility alternative and MAY be adopted later without changing any other part of the contract.

`MDL-2` The parent MUST spawn each role with the model pinned in its spec and MUST NOT override a role to an unlisted model at dispatch time. Model changes MUST happen by editing the spec plus docs, never ad hoc.

`MDL-3` The per-role model contract holds only when the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable is **unset**. The package MUST document that per-role routing requires this variable to be unset, because Claude Code resolves it ahead of frontmatter `model:` and would collapse the whole roster onto one model. `README.md` MUST surface this caveat, and the installer MUST warn when the variable is set (`INS-6`).

## 6. Dispatch and Orchestration

`SKL-1` Dispatch MUST be opt-in. The skill MUST activate only when the user explicitly asks for autobots, subagents, delegation, parallel execution, or model-tier routing. The `/autobots` slash command MUST invoke the same dispatcher.

`SKL-2` Escape hatches MUST take precedence over activation. If the user says any of `no subagents`, `do not use subagents`, `handle locally`, `do this yourself`, or `do not use autobots`, the parent MUST handle the task directly without dispatching.

`SKL-3` The parent MUST act as the orchestrator and DRA. It MUST: select the subagent; assign concrete scope and constraints; sequence work and decide when to stop or continue; assign disjoint ownership for parallel writable work; resolve conflicts between subagent outputs; verify results and decide which findings/patches to accept; treat subagent output as advisory until accepted; and consolidate results, conflicts, verification, and remaining risks into the final response.

`SKL-4` Subagents MUST NOT delegate or route. This invariant MUST be enforced structurally by omitting the `Agent` tool from every role (`AGT-10`), giving delegation depth of exactly one. This replaces Codex's `max_depth = 1`.

`SKL-5` In user-facing updates the parent SHOULD label each spawned subagent as `<role>: <task or scope>` (e.g. `helper-worker: dependency readiness review`). Any tool-generated agent id is traceability metadata only.

`SKL-6` `SKILL.md` MUST contain an explicit dispatch list of the ten role names that matches the agent files exactly (`VAL-9`), and MUST contain a pattern registry (§7 below) that matches the ones in `docs/design.md` and `docs/cheatsheet.md` (`VAL-10`).

## 7. Multi-Agent Patterns

`PAT-1` The skill MUST ship a pattern registry containing at least these entries:

| Pattern | Triggers | Roles used |
|---|---|---|
| `orchestrator-worker` (default) | any autobots dispatch that names no other pattern | all roles |
| `advisory` | `use the advisor strategy`, `advisory pattern`, or an explicit ask for a cheap executor with an advisor | one writable executor (`coding-worker` or `fast-coding-worker`) + `advisor` |

`PAT-2` Pattern selection MUST default to `orchestrator-worker` unless the user names another registered pattern by its triggers. A request for an unregistered pattern MUST fall back to the default, with a note to the user.

`PAT-3` Every registered pattern MUST satisfy the package invariants: opt-in dispatch with escape-hatch precedence (`SKL-1`, `SKL-2`); delegation exactly one level deep with no role granted `Agent` (`SKL-4`); parent is orchestrator/DRA and subagent output is advisory until accepted (`SKL-3`); every role keeps its pinned model, effort, and access class (`MDL-2`, `AGT-1`); and parallel writable work uses disjoint ownership or `isolation: worktree`.

`PAT-4` Pattern-specific protocol MUST live only in the parent's dispatch prompts (`SKILL.md`), never in the agent specs. Agent specs MUST remain pattern-agnostic.

`PAT-5` Patterns that cannot satisfy `PAT-3` (peer-to-peer topologies, dynamically created roles) MUST be treated as out of scope. Deterministic heavy fan-out over dozens of agents remains a non-goal.

`PAT-6` The `orchestrator-worker` default MUST support (at least) these recipes, retargeted to the kebab-case names: plan→implement→review (`planner`→`coding-worker`→`reviewer`); fast fix (`fast-coding-worker`, with `reviewer` when behavior/public API changes); investigation before editing (`helper-worker`→worker); deep root-cause (`forensic-analyst`→`coding-worker`); documentation drift (`doc-reviewer`); high-stakes/security review (`reviewer`); exploratory QA (`qa-engineer` after a feature lands, routing confirmed findings to a worker); edge-case/coverage analysis (`edge-case-analyst`, routing confirmed cases to a worker). For report-producing roles (`forensic-analyst`, `edge-case-analyst`) the parent MUST save the accepted report to a file only when the user requests it.

## 8. Advisory Pattern Protocol

`ADV-1` The `advisory` pattern MUST use exactly one writable executor — `coding-worker` (Sonnet, normal work) or `fast-coding-worker` (Haiku, maximum cost reduction) — plus the read-only `advisor` role (Fable 5, `xhigh`).

`ADV-2` The loop MUST be **parent-mediated**. Executors MUST NOT consult the advisor directly, because the type-restricted `Agent(advisor)` allowlist syntax is ignored when an agent runs as a subagent; granting `Agent` would break the depth-1 invariant (`SKL-4`).

`ADV-3` **Executor consult-request contract.** The parent MUST append a consult protocol to the executor's dispatch prompt instructing it to: work autonomously; and, when blocked on a decision it cannot reasonably resolve, stop and return a **structured consult request** containing at minimum:

1. the **question** (the specific decision it is blocked on);
2. the **options considered**;
3. **pointers to the relevant files and evidence**.

`ADV-4` **Advisor response contract.** The parent MUST forward the consult request and scope to `advisor`, which MUST return exactly one of three response types:

- a **plan** — how to proceed;
- a **correction** — a change of course;
- a **stop** — a signal to halt.

The advisor MUST NOT edit files and MUST NOT produce user-facing output.

`ADV-5` **Resume contract.** The parent MUST resume the *same* executor via `SendMessage`, relaying the guidance. The resumed subagent retains full context; the parent MUST NOT re-brief it. The loop repeats until the executor completes or the advisor signals stop.

`ADV-6` **Consult cap.** The dispatch prompt MUST cap consults per task. The default MUST be **3** (mirroring the API advisor's `max_uses`). On exhaustion the executor MUST return its best partial result and remaining open questions to the parent. **[Deferred]** The value 3 is a starting default to tune against real tasks; it is the required default until changed.

`ADV-7` The parent MUST remain DRA throughout and accept or reject the final result as usual (`SKL-3`).

`ADV-8` **Native session-level advisor (informative).** Claude Code v2.1.98+ (Anthropic API only) exposes the API advisor tool at session level via `/advisor`, the `advisorModel` key in `settings.json`, or `--advisor` at launch. It is **session-global** (applies to the parent and every subagent; there is no per-subagent `advisor:` frontmatter) and is **user-set only** — the skill MAY suggest setting it but MUST NOT set it. The parent-mediated flow (`ADV-2`–`ADV-7`) is the portable, per-task-scoped form. **[Deferred]** Whether `README.md` recommends `advisorModel` on the Anthropic API is an Open Question.

## 9. Validator Requirements

`scripts/validate_package.go` protects the package contract. It parses YAML frontmatter (splitting the `---` fenced block from the Markdown body) using `gopkg.in/yaml.v3`.

`VAL-1` The validator MUST verify every `.claude/agents/*.md` file has a parseable YAML frontmatter block and a non-empty system-prompt body.

`VAL-2` The validator MUST verify the required frontmatter fields are present and non-blank: `name`, `description`, `model`, `tools`.

`VAL-3` The validator MUST verify each agent's `name` matches its filename and that names are unique across the roster.

`VAL-4` The validator MUST verify `model` is one of `fable`, `opus`, `sonnet`, `haiku`.

`VAL-5` The validator MUST verify that `effort`, when present, is one of `low`/`medium`/`high`/`xhigh`/`max`, and that it is **absent on Haiku roles** (where it is inert).

`VAL-6` The validator MUST verify `tools` is well-formed, **never contains `Agent`**, and that the **derived access class** (writable iff `tools` includes `Edit` or `Write`) matches the Access column in `docs/design.md`.

`VAL-7` The validator MUST verify `README.md`, `SKILL.md`, `docs/design.md`, `docs/faq.md`, and `docs/cheatsheet.md` mention every configured agent as a standalone identifier — an occurrence embedded in a longer role name (e.g. `reviewer` inside `doc-reviewer`) MUST NOT count.

`VAL-8` The validator MUST verify `README.md`, `docs/design.md`, and `docs/cheatsheet.md` document each agent with its configured model on one line.

`VAL-9` The validator MUST verify `SKILL.md`'s exact dispatch list matches the agent files.

`VAL-10` The validator MUST verify the pattern registries in `SKILL.md`, `docs/design.md`, and `docs/cheatsheet.md` list the same pattern names, and that every role a pattern references exists as an agent file (**pattern-registry sync check**).

`VAL-11` The validator MUST verify `scripts/install.sh`'s agent list matches the agent files.

`VAL-12` The validator MUST verify deprecated project identifiers (e.g. Agenticons/Codex-specific names) do not remain in primary docs.

`VAL-13` The validator MUST exit non-zero on any failed check.

`VAL-14` The validator MUST verify the on-disk roster matches the normative table in §3 exactly: the same ten role names and, per role, the same `model`, `effort` (including its required absence on Haiku roles), and derived access class (`AGT-1`, `ART-3`). This is the only check whose expected values are embedded in the validator rather than derived from the files on disk, so the roster cannot drift from the spec even when every doc is updated to match the drifted files.

> The two conceptual changes from the Agenticons validator: (1) the access check validates a *derived* access class from the presence of editing tools rather than a literal `sandbox_mode` string (`VAL-6`); (2) the `effort`-validity (`VAL-5`) and `Agent`-exclusion (`VAL-6`) checks encode invariants implicit in Claude Code's model.

## 10. Installer Requirements

`scripts/install.sh` is the primary distribution path.

`INS-1` The installer MUST accept these flags (the Agenticons flag surface, unchanged):

| Flag | Effect |
|---|---|
| `--target <repo>` | Choose the repository to install into. |
| `--global` | Install for the current user under `~/.claude`. |
| `--dry-run` | Preview writes without applying them. |
| `--force` | Overwrite differing files. |
| `--ref <git-ref>` | Remote install from a specific Git ref. |

`INS-2` The installer MUST write to these destinations:

| Artifact | Repo-local destination | Global destination (`--global`) |
|---|---|---|
| Skill | `.claude/skills/autobots/SKILL.md` | `~/.claude/skills/autobots/SKILL.md` |
| Agents | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` |

`INS-3` The installer MUST work from a local checkout **and** through a raw GitHub pipe, where it downloads `SKILL.md` and `.claude/agents/*.md` from the selected ref.

`INS-4` The installer MUST embed the agent list, and that list MUST match the agent files exactly (`VAL-11`).

`INS-5` The installer MUST NOT overwrite existing, differing files unless `--force` is given, and MUST make no writes under `--dry-run`.

`INS-6` The installer MUST warn when `CLAUDE_CODE_SUBAGENT_MODEL` is set in the environment, because it silently overrides per-role model routing (`MDL-3`).

`INS-7` After install, the installer MUST advise the user to start a new Claude Code session so the agents are picked up (subagent file edits require a session restart unless made via `/agents`; skill edits are picked up live).

`INS-8` The installer MUST accept a `--symlink` flag that replaces the copy-based install (`INS-2`, `INS-5`) with a symlink-based install, valid in local-checkout mode only:

- **Remote mode.** `--symlink` in a remote (curl-pipe) install MUST cause the installer to `die` with a message directing the user to clone the repo and run the script from a local checkout instead, because a symlink needs a real on-disk target and a remote install has none.
- **Skill.** The installer MUST create a single directory symlink `<DEST_ROOT>/skills/autobots` → `<checkout>/.claude/skills/autobots`, not a copy of `SKILL.md`. This matches the convention where each `~/.claude/skills/<name>` is a symlink to a source directory containing the skill's `SKILL.md`.
- **Agents.** The installer MUST create one symlink per agent, `<DEST_ROOT>/agents/<name>.md` → `<checkout>/.claude/agents/<name>.md`. The agents directory is not symlinked as a whole because it holds files belonging to other, non-Autobots agents.
- **Targets.** Symlink targets MUST be absolute paths resolved from the checkout root.
- **Self-reference guard.** The installer MUST refuse (`die`) rather than install when a `--symlink` destination and its intended target resolve to the same physical path (e.g. running `--symlink` from inside the checkout with no `--target`/`--global`, or `--target` pointing at the checkout's own `.claude` under any spelling). Comparison MUST be on canonicalized, symlink-resolved paths, not literal strings, and MUST be checked both before any per-entry work begins and again per entry as defense in depth. This check applies regardless of `--dry-run` or `--force`, since `--force` would otherwise delete the source checkout it is trying to link from.
- **Target existence.** Before creating a symlink, the installer MUST verify the intended target exists on disk and `die` with the same message shape as a missing copy-mode source file if it does not; a missing target MUST NOT silently produce a dangling symlink reported as success.
- **Overwrite semantics.** `INS-5`'s safety semantics extend naturally to symlinks: an existing destination that is already a symlink to the correct target MUST be left alone and reported unchanged; an existing destination that is a file, a directory, or a symlink pointing elsewhere is a conflict and MUST be left untouched unless `--force` is given — when the existing destination is a real directory, the conflict message and any `--dry-run` preview MUST say plainly that `--force` deletes it and its contents recursively, since that is materially more destructive than replacing a stray symlink; with `--force` the installer MUST remove the existing destination first (so a real directory is not left holding a nested symlink) and then create the new symlink; `--dry-run` MUST preview symlink writes without creating them.
- **Copy-mode symlink awareness.** A copy-mode (`INS-5`) install MUST treat an existing destination that is itself a symlink, or whose parent directory is a symlink (e.g. a prior `--symlink` skill install), as its own conflict class rather than writing through it — `cp` follows a live symlink and would otherwise silently modify whatever it points at. This MUST be detected even when the link is dangling (target moved or deleted), and the same conflict/`--force` rules as `INS-5` apply, with the link itself removed before the real file is written.
- **Default remains copy.** `--symlink` is opt-in; without it the installer copies files as described in `INS-2`/`INS-5`, so target repos continue to receive a self-contained snapshot rather than a link into someone else's checkout.

## 11. Acceptance Criteria

`ACC-1` `go run ./scripts/validate_package.go` MUST pass (exit 0) with the full package present.

`ACC-2` `go test ./...` MUST pass.

`ACC-3` `go vet ./...` MUST pass.

`ACC-4` `.github/workflows/validate.yml` MUST run `ACC-1`–`ACC-3` on every push and pull request.

`ACC-5` All ten agent files, `SKILL.md`, `scripts/install.sh`, `README.md`, `docs/design.md`, `docs/faq.md`, and `docs/cheatsheet.md` MUST be mutually consistent per the validator checks (`VAL-1`–`VAL-14`).

## 12. Deferred Items (Open Questions)

The following are explicitly deferred per `docs/design.md` "Open Questions." Implementations MUST ship the stated default and leave the decision open:

| Tag | Item | Shipped default |
|---|---|---|
| `MDL-1` | Alias vs pinned full model ID | Aliases with documented ID mapping |
| `AGT-6` | `PreToolUse` write-guard hook for `Bash`-bearing read-only roles | Not shipped (convention + prompt discipline) |
| `ART-4` | Optional plugin distribution | Not shipped (file-based only) |
| — | User-tunable subagent-concurrency cap in `.claude/settings.json` | Not shipped (parent-controlled + internal cap) |
| `ADV-6` | Advisory consult cap value | `3` |
| `AGT-10` | `advisor` (and `doc-reviewer`/`planner`) strict no-shell profile | Standard read-only profile (`AGT-7`) |
| `ADV-8` | README recommendation of session-level `advisorModel` | Undecided (not required) |
