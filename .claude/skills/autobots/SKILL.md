---
name: autobots
description: >-
  Use this skill when the user explicitly asks for autobots, subagents,
  delegation, parallel execution, or model-tier routing (e.g. "use autobots",
  "delegate this to a subagent", "run these in parallel", "have a
  helper-worker look into this", "use the advisor strategy"). Also invoked
  directly as the `/autobots` slash command. Do NOT activate on generic
  requests to "help with" or "look into" something — only on an explicit ask
  for delegation/subagents/autobots/parallel work/model-tier routing.
---

# Autobots Dispatcher

Autobots is a fixed, named roster of ten Claude Code subagents for planning,
implementation, review, documentation review, investigation, and QA
verification. This skill is the dispatcher: it decides *whether* to delegate,
*which* pattern and role(s) to use, and *how* to run the delegation loop. It
does not replace your judgment — you remain the orchestrator for the whole
task.

## 1. Opt-in activation (SKL-1)

Activate this dispatcher **only** when the user explicitly asks for autobots,
subagents, delegation, parallel execution, or model-tier routing. `/autobots`
invokes this same dispatcher directly. Do not activate on an ordinary request
to "fix," "investigate," or "review" something with no mention of delegation —
handle those yourself unless dispatch is explicitly requested.

## 2. Escape hatches (SKL-2) — these win over activation

If the user says any of the following, handle the task yourself directly and
do **not** dispatch, even if the request would otherwise qualify for autobots:

- `no subagents`
- `do not use subagents`
- `handle locally`
- `do this yourself`
- `do not use autobots`

Escape hatches take precedence over every other rule in this file.

## 3. You are the orchestrator and DRA (SKL-3)

You (the parent) are the orchestrator and the Directly Responsible Agent
(DRA) for the whole task — accountability never transfers to a subagent. You
must:

- select the right subagent(s) for the job;
- assign each subagent a concrete scope and concrete constraints;
- sequence work and decide when to stop, continue, or re-dispatch;
- assign **disjoint ownership** when running parallel writable work (or use
  `isolation: worktree`);
- resolve conflicts between subagent outputs yourself;
- verify results and decide which findings or patches to accept;
- treat every subagent's output as **advisory until you accept it** — never
  pass it straight through unexamined;
- consolidate results, conflicts, verification, and remaining risks into a
  single final response to the user.

## 4. No nested delegation (SKL-4)

Subagents never delegate or route further. This is enforced structurally: no
role's `tools` list includes the `Agent` tool, so no subagent can spawn
anything. Delegation depth is exactly one — you dispatch to a subagent, and
that subagent returns to you. Never grant a subagent the `Agent` tool, and
never ask a subagent to "delegate to" or "coordinate" other agents.

## 5. Semantic labels (SKL-5)

In every user-facing update, label each spawned subagent as
`<role>: <task or scope>`, for example:

- `helper-worker: dependency readiness review`
- `coding-worker: implement rate limiter in src/middleware`
- `reviewer: security review of auth changes`

Any tool-generated agent id is traceability metadata only — the semantic
label is what the user sees.

## Roster (dispatch list)

- `planner` — architecture, decomposition, sequencing, risk analysis (read-only)
- `coding-worker` — normal implementation, bug fixes, refactors (writable)
- `fast-coding-worker` — small localized edits and quick fixes (writable)
- `helper-worker` — quick lookup, repo reconnaissance, evidence gathering (read-only)
- `forensic-analyst` — deep root-cause investigation, forensic reports (read-only)
- `doc-reviewer` — documentation correctness and drift review (read-only)
- `reviewer` — correctness, security, maintainability, regression review (read-only)
- `qa-engineer` — exploratory end-to-end QA verification (writable)
- `edge-case-analyst` — edge-case and coverage-gap discovery (read-only)
- `advisor` — guidance-only consultant for the advisory pattern (read-only)

Every subagent above is spawned via the `Agent` tool with `subagent_type: <name>`
matching its `.claude/agents/<name>.md` file. Each role is pinned to its own
model and effort in its spec — do not override a role's model at dispatch
time; model changes happen by editing the agent spec, never ad hoc. Per-role
model routing only holds when `CLAUDE_CODE_SUBAGENT_MODEL` is **unset** — if
it's set in the environment, every role collapses onto that one model
regardless of its spec, so check for it if routing looks wrong.

## Pattern registry

Pattern selection defaults to `orchestrator-worker` unless the user names
another registered pattern by its triggers. A request for an unregistered
pattern falls back to the default, with a note to the user that the named
pattern isn't recognized.

| Pattern | Triggers | Roles used |
|---|---|---|
| `orchestrator-worker` (default) | any autobots dispatch that names no other pattern | all roles |
| `advisory` | `use the advisor strategy`, `advisory pattern`, or an explicit ask for a cheap executor with an advisor | one writable executor (`coding-worker` or `fast-coding-worker`) + `advisor` |

Pattern-specific protocol (below) lives only here in `SKILL.md` — never add
pattern logic to an agent spec. Agent specs stay pattern-agnostic.

## `orchestrator-worker` recipes (default pattern)

Use these as starting points, not a rigid menu — combine or skip steps to fit
the actual task. In every recipe you dispatch each step, review what comes
back, and decide whether to proceed, redo, or stop before moving on.

- **Plan then implement.** `planner` → `coding-worker` → `reviewer`. Use for
  anything that benefits from an explicit decomposition before code is
  written.
- **Fast fix.** `fast-coding-worker` alone for small, well-understood
  changes; add `reviewer` when the change touches behavior or a public API.
- **Investigation before editing.** `helper-worker` for reconnaissance, then
  route the confirmed scope to `coding-worker` or `fast-coding-worker`.
- **Deep root-cause.** `forensic-analyst` investigates an intermittent or
  cross-system failure; once it confirms a root cause, route the fix to
  `coding-worker`.
- **Documentation drift.** `doc-reviewer` alone, checking docs against the
  current code.
- **High-stakes or security-sensitive review.** `reviewer` alone, or as the
  last step after implementation.
- **Exploratory QA.** `qa-engineer` after a feature lands (or before a
  release), exercising the change end-to-end; route any confirmed findings
  to `coding-worker` or `fast-coding-worker`.
- **Edge-case / coverage analysis.** `edge-case-analyst` surfaces uncovered
  cases with proposed specs and concrete test cases; route confirmed cases
  to `coding-worker` or `fast-coding-worker`.

**Report-producing roles.** `forensic-analyst` and `edge-case-analyst` return
reports, not files. Save an accepted report to disk **only if the user asks
for it** — otherwise fold the findings into your response and route
confirmed follow-ups to a worker.

**Parallel writable work.** When two writable workers (`coding-worker`,
`fast-coding-worker`, `qa-engineer`) run in parallel, give each disjoint
ownership (non-overlapping files/scopes) or spawn them with
`isolation: worktree` for a stronger guarantee. Parallel review work should
use distinct review angles (e.g. correctness vs. security vs. regression
risk) rather than duplicate the same pass.

## Advisory pattern protocol

Triggered by `use the advisor strategy`, `advisory pattern`, or an explicit
ask for a cheap executor with an advisor. Use this instead of the default
when the user wants a cost-effective executor that escalates to a stronger
model only at hard decision points.

**Roles (ADV-1).** Exactly one writable executor — `coding-worker` (Sonnet,
normal work) or `fast-coding-worker` (Haiku, maximum cost reduction) — plus
the read-only `advisor` (Fable 5, `xhigh`).

**The loop is parent-mediated (ADV-2).** Executors must never consult the
advisor directly — they have no `Agent` tool, so a direct consult is
impossible, and granting one would break the depth-1 invariant. You sit
between the executor and the advisor for every consult.

**Executor consult-request contract (ADV-3).** When you dispatch the
executor, append this consult protocol to its prompt: work autonomously; if
you get blocked on a decision you cannot reasonably resolve on your own,
stop and return a structured consult request containing at least:

1. the **question** — the specific decision you're blocked on;
2. the **options considered**;
3. **pointers to the relevant files and evidence**.

**Advisor response contract (ADV-4).** When the executor returns a consult
request, forward the request plus relevant scope to `advisor`. `advisor`
must return exactly one of:

- a **plan** — how to proceed;
- a **correction** — a change of course;
- a **stop** — a signal to halt.

`advisor` never edits files and never produces user-facing output; its
response is guidance to you, which you relay.

**Resume contract (ADV-5).** Resume the *same* executor via `SendMessage`,
relaying the advisor's guidance. The resumed subagent retains its full
context — do not re-brief it from scratch. Repeat the consult loop until the
executor completes the task or the advisor signals stop.

**Consult cap (ADV-6).** Cap consults at **3** per task by default. If the
cap is exhausted, have the executor return its best partial result plus its
remaining open questions instead of continuing to loop.

**You remain DRA throughout (ADV-7).** Accept or reject the executor's final
result exactly as you would in the default pattern — advisory guidance does
not change your verification responsibility.

**Native session advisor (ADV-8, informative only).** Claude Code v2.1.98+
on the Anthropic API exposes a session-level advisor via `/advisor`, the
`advisorModel` key in `settings.json`, or `--advisor` at launch. It is
session-global (applies to the parent and every subagent, with no
per-subagent `advisor:` field) and is user-set only. You may mention this
option to the user as a faster alternative, but you must never set it
yourself — the parent-mediated flow above is the portable, per-task-scoped
form and is what this skill implements.
