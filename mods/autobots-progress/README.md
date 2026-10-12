# autobots-progress

A Claude Code mod for the autobots dispatcher: a progress bar above the prompt and a live panel of subagents.

- **Progress bar**: the dispatch title (`autobots` until one is reported), phase, accepted tasks out of planned, and a button with the crew size that opens the panel. It appears once the dispatcher reports progress or a roster subagent starts. Other mods' rows above the prompt, such as decision-desk's open questions, stay visible below it.
- **Agents panel** (`/agents-info` toggles it): running, finished and planned subagents with role, model, effort, context, estimated cost and time. Subagents off the roster show in grey under their own type.
  Each subagent's row also shows its activity: tool calls so far, the most recent tool, and, while it runs, how long ago its last model step was (`3 calls · Read a.rb · 12s ago`). The subagent's final `SubagentHandback` call, which hands its report back, is not shown or counted. Subagents do not report their own steps: the mod observes every model step. The panel shows each running worker's context fill as its bar, in grey.
  The activity names only the tool and a short target: a file's basename, a Grep pattern cut to 24 characters, the last segment of a Glob pattern (after its last `/` or `\`) cut the same way, a URL's host, and for Bash only the command's file name (leading `NAME=value` assignments skipped, directories dropped, cut to 24 characters). It never shows a full command, URL, web search query or path, and other tools show by name only. If a Grep pattern, the shown Glob segment or the Bash file name looks like it holds a key or secret (a known key prefix, a private-key header, a JWT, credentials in a URL, `password=`, `api_key:` or the like, a bearer token, or a long random-looking string), or is over 512 characters, the tool shows by name only. The same check covers the text the model writes: in the flow's title, a planned task's title and a subagent's description, on the band and in the panel, a word that looks like a key or secret shows as `•••` and the other words stay readable (`rotate ••• key`). When a secret spans words, every word of its value is masked: a quoted value up to its closing quote (`password: "correct horse"`) or, with no closing quote, to the end of the text, and a value after a `Bearer` or `Basic` scheme. Which of the neighbouring words stay readable is not fixed. A title or description over 512 characters shows as `•••` whole. The masking is for display only: a planned task still matches its run by the real text. The check is a heuristic: a bare short password with no `password=` in front can still show. The whole summary is cut to 40 characters. On the terminal the activity follows the context, tokens, cost and time, so a narrow row drops it first.
  Each subagent's row also shows its prompt cache, from its own steps: the hit rate over every step (cache reads out of all input tokens) and, for 5 minutes after its last step, `warm m:ss` counting down, then `cold` (`cache 92% · warm 3:41`). While a step is out the cache counts as warm. The crab shows the same temperature: in full color at the end of a step, fading to grey over the 5 minutes, frosted blue-white once cold, and steaming while a running subagent's latest step is a rebuild (a cache read more than 1,024 tokens short of the previous step's read plus write, on the same model). On the desktop a strip of bars beside the role and model line shows the most recent steps, up to 80: each bar is a solid part for the step's cache read with a fainter part for its cache write stacked on it, and a rebuild has a mark and says on hover how long the cache sat and how many tokens it rewrote. The cache view is only in the panel, not on the band. On the terminal the cache text follows the time, and a narrow row drops the activity before it. Where the terminal draws no images, only the text shows the temperature: herdr is one, unless Claude Code starts with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` (see below).

## Autobots Mode

While an autobots flow is active, the mod counts the file edits the main agent makes itself instead of delegating to the roster. It does not block them.

- **When it counts**: from the start of a flow until the progress call with `finished: true`, or until the band is dismissed. A flow starts when the main agent loads the autobots skill (`autobots` or `<plugin>:autobots`), when a prompt starts with `/autobots`, or at a progress call that starts a new flow. A flow started only by a roster subagent counts nothing until the dispatcher reports progress.
- **What counts**: a main-agent Edit, Write or NotebookEdit call on a file inside the session's working directory, and a Bash command that writes one: an output redirect or `tee`, `sed -i`, `perl -i`, `ruby -i`, `cp`, `mv`, `rm`, `git apply`, `patch`, `git checkout -- <path>` or `git restore`. A Bash command counts once, however many files it writes. A call that was refused or failed does not count, and neither do subagents' edits or writes under `/tmp`, `$TMPDIR` (the scratchpad), `/dev` or `~/.claude`. So a session whose working directory is under `/tmp`, `$TMPDIR` or `~/.claude` counts nothing. The Bash check is a heuristic: it reads the command's words past `sudo`, `env`, `time`, `nohup`, `command` and loop or `if` keywords, and follows `cd`, inside a subshell only until its `)`. It misses writes made through `bash -c`, `xargs`, `find -delete`, `$(…)`, scripts, MCP tools, formatters or generators, and it counts the `>` of a comparison such as `(( a > b ))` or `[ a > b ]` as a write.
- **Where it shows**: `✎ 3` beside the phase label on the band once the count is above 0, and `Main agent: 3 direct edits` in the agents panel. Both stay after `finished: true` until the band is dismissed or a new flow starts.
- **What the main agent sees**: one reminder on the flow's first counted edit, after the tool's own output, saying that edits belong to the roster. The `finished: true` progress result states the count (`ok: Done · main agent made 3 direct edits during this flow; include this count in your closing summary`), so it reaches the closing summary.

The mod keeps only the count: never the command, path or file name of an edit.

## Load it

```sh
claude --plugin-dir mods/autobots-progress
```

On the terminal, clicking the bar's and panel's buttons works only in the fullscreen layout (`/tui fullscreen`). The keyboard works in either layout: `ctrl+x tab` focuses the panel or bar, `tab` moves between buttons, `enter` presses one and `esc` returns to the prompt.

The panel draws its crabs as images where the terminal supports kitty graphics, and the `▣` glyph elsewhere. Claude Code 2.1.296 does not draw images in herdr 0.9.1: herdr identifies itself as `libghostty`, and Claude Code turns images off for it (the `--debug` log shows `kittyGraphics=no (probe: graphics reply OK, terminal libghostty)`). If you use herdr, start Claude Code with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` to turn images on.

## Tools it adds

- `mcp__autobots-progress__progress`: the dispatcher reports the plan (each task with its `role`), phase and accepted tasks. The autobots `SKILL.md` drives it.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Roles

Each role has its own color and its own crab, dressed for the job. Planned tasks show their role's crab dimmed. On the desktop some props move; `prefers-reduced-motion` stops them. The terminal draws the same pixels as a still image.

| Role | Crab |
| --- | --- |
| planner | holds up a rolled blueprint |
| advisor | wears a graduation cap |
| coding-worker | wears a hard hat and turns a wrench |
| fast-coding-worker | wears a headband, with speed lines |
| helper-worker | holds a flashlight |
| forensic-analyst | wears a deerstalker and holds a magnifying glass |
| doc-reviewer | wears reading glasses and holds an open book |
| reviewer | wears a monocle and holds a red pen |
| qa-engineer | wears goggles and holds a bug net |
| edge-case-analyst | wears a caution cone |
| spec-test-writer | holds a checklist, with a pencil |
| Explore | dresses as a pirate |

Other subagent types get a plain crab.

## Attribution

Derived from savvy-progress by johnnyvizz (claude-kit @ 272a877), MIT — see LICENSE.
