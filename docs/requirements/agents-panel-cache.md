# Agents panel cache view requirements

The cache view extends the agents panel of the `autobots-progress` mod (`mods/autobots-progress`). It shows how each subagent's prompt cache behaves: how much of its input the cache served, whether the cache is still warm, and when it was rebuilt.

This file states requirements only. Spec tests are generated from it; once they exist, the tests define behavior.

## Problem

The panel shows each subagent's context, tokens, cost and time, but not how its prompt cache behaves. The owner wants to see that behavior to understand the system, not to save cost.

These figures come from the five subagent transcripts of one session (2026-10-11), deduplicated by message id:

- Every subagent cache write used the 5-minute TTL. The main session uses the 1-hour TTL; the panel shows subagents only.
- The share of input served from the cache was 89% to 92% for every subagent.
- On every call but two, the cache read equalled the previous call's cache read plus cache write. The two exceptions were coding workers resumed 10.9 and 14.3 minutes after their last call, past the 5-minute TTL; each rewrote its whole prefix (57K and 76K tokens).
- Every subagent's first call read nothing from the cache and wrote 9K to 11K tokens.

## Agreed decisions (2026-10-12)

| Topic | Decision |
|---|---|
| Purpose | Understanding how the system behaves. Not a cost warning. |
| Where it shows | The agents panel only: each subagent's row, on the terminal and the desktop. Not the progress band. |
| Hit rate | Shown per subagent as text. |
| Warm or cold | Shown per subagent as text, with the time left while warm. |
| Per-call strip | On the desktop only. |
| Crab | Each role's crab shows the cache temperature: normal while warm, fading as the TTL runs down, frosted when cold. |
| Cause labels | None. The view never says why a rebuild happened. |
| TTL | 5 minutes. The engine's usage reports no TTL breakdown, so the mod cannot read it. |

## Requirements

### Data

1. For each subagent, the mod keeps, per model step: the cache read tokens, the cache write tokens, the uncached input tokens, the model, and when the step happened.
2. A step is a **rebuild** when its cache read is more than 1,024 tokens below the previous step's cache read plus cache write, and both steps used the same model. A subagent's first step is never a rebuild. A step on a different model from the previous step is never a rebuild.

### Text on each row

3. Once a subagent has at least one step, its row shows `cache N%`, where N is the sum of its cache reads divided by the sum of its cache reads, cache writes and uncached input, rounded to a whole percent. Before its first step, and for planned tasks, the row shows no cache text.
4. A subagent is **warm** for less than 5 minutes after its last step, and **cold** from 5 minutes on. A subagent whose step is in progress is warm. While warm, the row shows `warm m:ss` after the hit rate, counting down the time left. When cold, it shows `cold`.
5. On the terminal the cache text follows the existing stats. When the row is too narrow, the activity summary drops first, then the cache text.
6. The cache text shows on the terminal whether or not the terminal draws images, and on the desktop.

### The crab

7. While a subagent's step is in progress, and at the moment a step ends, its crab's colors look as they do today. Steam (requirement 10) is drawn on top and does not count against this.
8. As the TTL runs down after a step, the crab fades steadily from its full colors toward grey: unchanged when the step ends, fully grey at 5 minutes.
9. When cold, the crab is frosted (a blue-white tint) and shows a small snowflake.
10. While a subagent's latest step is a rebuild and the subagent is running, its crab shows a puff of steam.
11. Planned tasks keep their dimmed crab, with no temperature.
12. On the desktop, the frost and the steam may animate; `prefers-reduced-motion` stops them, as it does the existing props. The terminal draws the same pixels as a still image. Where the terminal draws no images, the crab is the `▣` glyph and only the text shows the temperature.

### The strip (desktop only)

13. Each subagent's row on the desktop shows a strip with one bar per step, oldest first. A bar shows the step's cache read and cache write as two parts, read darker and write lighter, scaled to the largest step in the strip.
14. A rebuild step's bar is marked so it stands out from the others, and its hover text gives the minutes since the previous step and the tokens rewritten.
15. When there are more steps than fit, the strip shows the most recent ones.

### Redraws

16. A subagent's row redraws as its countdown and fade change, including after the subagent has finished, until it is cold. A cold, finished subagent's row stops redrawing for the cache view.
