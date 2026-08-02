# Autobots Cheatsheet

Quick reference for using the Autobots delegation skill in Claude Code. For the
full contract see [`docs/spec.md`](./spec.md); for rationale see
[`docs/design.md`](./design.md).

Autobots gives you a fixed roster of ten named subagents, each pinned to a
deliberate Claude model tier. You (the parent) stay the orchestrator — subagents
return findings/results, and you decide what to accept.

---

## Turn it on / off

**Activate** — dispatch is opt-in. Say any of:

- "use autobots …" or the `/autobots` slash command
- "delegate this …", "use a subagent …", "run these in parallel …"
- ask for model-tier routing (e.g. "use a cheap model for this, escalate hard calls")

**Do NOT auto-activate** on a plain "help me with…" / "look into…" — you have to
ask for delegation explicitly.

**Escape hatches** (these win over activation) — say any of:

- `no subagents` · `do not use subagents` · `handle locally` · `do this yourself` · `do not use autobots`

→ the parent does the task directly, no dispatch.

---

## The roster (ten roles)

Distribution: **3 Fable · 2 Opus · 3 Sonnet · 2 Haiku**.

| Role | Model | Effort | Access | Reach for it when… |
|---|---|---|---|---|
| `planner` | Fable 5 | xhigh | read-only | you need architecture, decomposition, sequencing, risk analysis before code |
| `coding-worker` | Sonnet 5 | high | **writable** | normal-scope implementation, bug fixes, refactors |
| `fast-coding-worker` | Haiku 4.5 | — | **writable** | small, localized, low-risk edits / quick fixes |
| `helper-worker` | Haiku 4.5 | — | read-only | quick lookup, repo recon, evidence gathering before editing |
| `forensic-analyst` | Fable 5 | xhigh | read-only | deep root-cause on hard/intermittent/cross-system bugs |
| `doc-reviewer` | Sonnet 5 | medium | read-only | documentation correctness / drift review |
| `reviewer` | Opus 4.8 | high | read-only | correctness, security, maintainability, regression review |
| `qa-engineer` | Sonnet 5 | high | **writable** | exercise a change end-to-end (regressions, perf, UX rough edges) |
| `edge-case-analyst` | Opus 4.8 | high | read-only | find uncovered cases + propose specs and concrete test cases |
| `advisor` | Fable 5 | xhigh | read-only | guidance-only consultant for the advisory pattern (plan / correction / stop) |

Only the three **writable** roles can edit files. The other seven are read-only
(they can still run read-only shell inspection). No role can spawn another
subagent — delegation is exactly one level deep.

---

## Patterns

| Pattern | Triggers | Roles used |
|---|---|---|
| `orchestrator-worker` (default) | any autobots dispatch that names no other pattern | all roles |
| `advisory` | "use the advisor strategy", "advisory pattern", or "cheap executor + advisor" | one writable executor (`coding-worker` **or** `fast-coding-worker`) + `advisor` |

An unregistered pattern falls back to the default (with a note).

### `orchestrator-worker` recipes

- **Plan → implement → review:** `planner` → `coding-worker` → `reviewer`
- **Fast fix:** `fast-coding-worker` (add `reviewer` if behavior/public API changes)
- **Investigate before editing:** `helper-worker` → worker
- **Deep root-cause:** `forensic-analyst` → `coding-worker`
- **Doc drift:** `doc-reviewer`
- **High-stakes / security review:** `reviewer`
- **Exploratory QA:** `qa-engineer` after a feature lands → route confirmed findings to a worker
- **Edge-case / coverage:** `edge-case-analyst` → route confirmed cases to a worker

> For report-producing roles (`forensic-analyst`, `edge-case-analyst`) the parent
> saves the report to a file **only when you ask**.

### `advisory` loop (parent-mediated)

1. Parent spawns the executor (`coding-worker` or `fast-coding-worker`) with a
   consult protocol appended: work autonomously; when blocked, stop and return a
   structured consult request (**question · options considered · file/evidence pointers**).
2. Parent forwards the request to `advisor`, which returns exactly one of:
   **a plan · a correction · a stop**.
3. Parent resumes the **same** executor via `SendMessage` (it keeps full context — no re-brief).
4. Repeat until done or `advisor` says stop. **Consult cap: 3** per task, then the
   executor returns its best partial result + open questions.

---

## Model routing gotcha

Per-role model routing only works when the `CLAUDE_CODE_SUBAGENT_MODEL`
environment variable is **unset**. If it's set, Claude Code resolves it ahead of
each role's frontmatter `model:` and collapses the whole roster onto one model.

```bash
# check it's not set:
printenv CLAUDE_CODE_SUBAGENT_MODEL   # should print nothing
```

Also check `~/.claude/settings.json` for an `env` block setting it. The installer
warns you when the variable is set.

---

## Install

```bash
# into a repo (local checkout)
bash scripts/install.sh --target /path/to/repo

# for your user, globally (~/.claude)
bash scripts/install.sh --global

# preview without writing / overwrite differing files
bash scripts/install.sh --target . --dry-run
bash scripts/install.sh --target . --force

# symlink into a local checkout instead of copying (local-checkout mode only)
bash scripts/install.sh --global --symlink

# remote, from a git ref
curl -fsSL https://raw.githubusercontent.com/fuentesjr/autobots/main/scripts/install.sh | bash -s -- --global --ref main
```

After installing, **start a new Claude Code session** so the agents load (skill
edits are picked up live; agent files need a restart unless edited via `/agents`).

---

## Example dispatch phrasings

- "Use autobots: plan the auth refactor, then implement it, then review it."
- "Delegate a quick typo fix in `README.md`." → `fast-coding-worker`
- "Use autobots to root-cause the flaky checkout test." → `forensic-analyst`
- "Have a helper-worker check how retries are wired before we change anything."
- "Use the advisor strategy to add the missing null check cheaply."
- "Add the null check — no subagents." → parent does it directly (escape hatch)
