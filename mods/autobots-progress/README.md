# autobots-progress

A Claude Code mod for the autobots dispatcher: a progress bar above the prompt and a live panel of subagents.

- **Progress bar**: the dispatch title (`autobots` until one is reported), phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once the dispatcher reports progress or a roster subagent starts.
- **Agents panel** (`/agents-info` toggles it): running, finished and planned subagents with role, model, effort, context, estimated cost and time. Subagents off the roster show in grey under their own type.

## Load it

```sh
claude --plugin-dir mods/autobots-progress
```

## Tools it adds

- `mcp__autobots-progress__progress`: the dispatcher reports the plan (each task with its `role`), phase and accepted tasks. The autobots `SKILL.md` drives it.

Subagents do not report their own steps. The panel shows each running worker's context fill as its bar, in grey.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Roles

Each role has its own color, and its crab wears one of five animated props. `prefers-reduced-motion` stops them.

| Prop | Roles |
| --- | --- |
| astronaut (floats) | planner, advisor |
| detective (sweeps a magnifier) | helper-worker, forensic-analyst, edge-case-analyst, reviewer, doc-reviewer |
| engineer (turns a wrench) | coding-worker, qa-engineer |
| chef (tosses an omelette) | spec-test-writer |
| racer (runs with a flag) | fast-coding-worker |

## Settings

`language`: `auto` (default), `en` or `ru`. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "autobots-progress": { "options": { "language": "ru" } } } }
```

## Attribution

Derived from savvy-progress by johnnyvizz (claude-kit @ 272a877), MIT — see LICENSE.
