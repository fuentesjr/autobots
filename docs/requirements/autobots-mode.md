# Autobots Mode requirements

Autobots Mode extends the `autobots-progress` mod (`mods/autobots-progress`). While an autobots flow is active, it counts the file edits the main agent makes itself instead of delegating to the roster, and shows that count to the owner.

This file states requirements only. Spec tests are generated from it; once they exist, the tests define behavior.

## Problem

When the owner asks for autobots, the main agent sometimes does the work itself (edits files directly) instead of delegating to the roster. Nothing makes that visible: the progress band and the agents panel show only subagents.

These figures come from `scripts/autobots_flow_scan.rb` (run 2026-10-11 over 92 transcripts), which scans the main agent's tool calls in session transcripts. A flow runs from an autobots `Skill` call, an `/autobots` prompt or the first progress call, until `finished: true`, the next flow start, or the end of the transcript:

- 27 autobots flows; 26 of them dispatched at least one subagent.
- In 21 of the 27 flows, the main agent also wrote project files itself.
- Across those flows, the main agent made 98 Edit or Write calls on project files, and ran 128 Bash commands that wrote project files (`sed -i`, redirects, `cp`, `git apply` and the like). Writes to temporary, scratchpad and `~/.claude` paths are excluded: an earlier draft of the scan that included them counted 347 Bash writes, mostly test logs and throwaway reproductions.
- 9 of the 27 flows ended with a `finished: true` progress call. Of 21 transcripts that loaded the autobots skill, 5 ever called the progress tool. The mod is recent, so earlier sessions could not call it.

## Agreed decisions (2026-10-11)

| Topic | Decision |
|---|---|
| Home | The existing `autobots-progress` mod. No new mod. |
| Enforcement | Count the main agent's direct file edits; do not block them. |
| Counted tools | Edit, Write, NotebookEdit, and Bash file writes where practical. |
| Whose edits | The main agent's only. Subagent edits do not count. |
| Where it shows | The progress band, the agents panel, and the flow's closing summary, through the `finished: true` progress result. The autobots `SKILL.md` does not change. |
| Flow start | The autobots skill loading (a `Skill` call or an `/autobots` prompt), or the first progress call. |
| Bash writes | The forms in requirement 10, once per command. |
| Scope | Project files only: requirements 9 to 11. |
| Threshold warning | None in v1. |
| Feedback to the agent | One non-blocking reminder on the first counted edit of a flow. |
| Baseline script | Committed as `scripts/autobots_flow_scan.rb`. |

## Required behavior

### Flow window

1. Counting is active from the start of a flow until the progress call with `finished: true`.
2. A counting flow starts at any of:
   - a main-agent `Skill` call for the autobots skill: `skill` is `autobots`, or ends in `:autobots`;
   - an owner prompt that starts with `/autobots`;
   - a progress call that the mod already treats as starting a new flow: the first progress call, a call after `finished: true`, or a call with a different `title`, except as requirement 4 says.
3. A new counting flow starts the count at 0. A flow started by the autobots skill shows the band titled `autobots`, as a flow started by a roster subagent spawn does today. An autobots `Skill` call or `/autobots` prompt during a counting flow starts a new counting flow, with the count at 0.
4. The first progress call after a flow started by the autobots skill continues that flow: it sets the title and keeps the count.
5. A flow started only by a roster subagent spawn does not count edits and shows no count. A progress call during such a flow starts counting, with the count at 0, unless it has `finished: true`.
6. Dismissing the band (✕) ends counting for that flow.
7. Outside a counting flow, no edit is counted.

### What counts

8. A counted edit is a main-agent tool call that ran: the engine did not refuse it, and the tool did not return an error. A call is the main agent's when its `tool.call` event has no `agentId`.
9. Edit and Write calls count when their `file_path` is inside the session's working directory, and NotebookEdit calls when their `notebook_path` is.
10. A Bash call counts once, however many files it writes, when it contains one of these forms with a target inside the session's working directory:
   - an output redirect (`>` or `>>`) to a file, or `tee` to a file;
   - an in-place edit: `sed -i`, `perl -i`, `ruby -i`;
   - `cp`, `mv` or `rm`;
   - `git apply`, `patch`, `git checkout -- <path>`, `git restore`.

   A relative target counts as inside the working directory.
11. These never count: targets under a temporary directory (`/tmp`, `/private/tmp`, `$TMPDIR`), where the session scratchpad lives, or under `~/.claude`; redirects to `/dev/null` or to another file descriptor (`2>&1`).
12. The mod keeps only the count. It does not keep or show the command, the path or the file name of a counted edit.

### Showing the count

13. While the count is above 0, the progress band shows it next to the phase label, on the terminal and the desktop, for example `✎ 3`. At 0, the band is unchanged.
14. The agents panel header shows the count for the active flow, on the terminal and the desktop, for example `Main agent: 3 direct edits`, including at 0.
15. The count's text is English. The mod has no other display language.
16. The count stays on the band and in the panel after `finished: true`, until the band is dismissed or a new flow starts.

### Reminder to the main agent

17. On the first counted edit of a flow, the tool call returns one reminder for the main agent alongside the tool's own output: an autobots flow is active, and edits belong to the roster. The tool's own output is unchanged, and the call is not refused.
18. Later counted edits in the same flow carry no reminder.

### Closing summary

19. The result of the progress call with `finished: true` states the count, for example `ok: Done · main agent made 3 direct edits during this flow; include this count in your closing summary`. At 0, the result says the main agent made no direct edits. A `finished: true` call that arrives in a flow started only by a roster subagent spawn (requirement 5) does not start counting, and its result is unchanged.
20. The result of any other progress call is unchanged.

### Compatibility

21. The existing `autobots-progress` spec tests keep passing.

## Out of scope for v1

- Blocking or delaying direct edits.
- Warning when the count crosses a threshold.
- Listing which files the main agent edited.
- Counting writes made through MCP tools, or through scripts the main agent runs, such as a Ruby or Python program that writes files.
- Formatters and generators that rewrite files (`rubocop -a`, `prettier --write`, `bundle install`).
- Changing the autobots `SKILL.md`. Requirement 19 reaches the closing summary through the tool result instead.

## How we'd know it works

The count is visibility, not enforcement: a main agent can still write files in ways requirement 10 does not detect.

- **Live check:** in a session started with `--plugin-dir mods/autobots-progress`, an autobots flow where the main agent edits a project file shows `✎ 1` on the band and `1` in the panel. A subagent's edit leaves the count unchanged. The `finished: true` result names the count.
- **Effect:** about two weeks after install, re-run the flow scan (`ruby scripts/autobots_flow_scan.rb`) and compare with the baseline above. Success is a lower share of flows with main-agent writes to project files than 21 of 27, and fewer such edits per flow.
- **Reach:** in the same scan, the share of autobots flows that call the progress tool. A flow that neither loads the autobots skill nor calls the progress tool is never counted (requirement 2).
