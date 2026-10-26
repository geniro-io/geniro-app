---
description: Statistics of a run, thread, call conversation, agent or sub-agent are computed by the daemon over every row of the run — never folded from the renderer's loaded window or bounded by a capped listing
paths:
  - "apps/daemon/src/**"
  - "apps/ui/src/renderer/**"
---

# Statistics are counted by the daemon, over every row

A figure that describes a run, a thread, a call conversation, an agent or a sub-agent — tool counts, spend, tokens spent, worked time, turn counts, cache expiry — states the whole history, not what happens to be loaded. A context reading is a level (the newest one), not a statistic. A tool count is the agent's own calls, every one its CLI made (a call a card hides included); a nested sub-agent or call has a count of its own.

- The daemon computes it over every row of the run: an aggregate over `items`, or a total written by increments. The renderer never folds it from loaded `items`; the transcript is a window, and a fold silently describes the window.
- A listing cap never bounds a figure. A route that caps a heavy listing (the call briefs under `CALL_CONTEXT_SNAPSHOT_LIMIT`) carries the figures in a separate uncapped list (`NodeStateWire.callFigures`).
- The renderer adds only what no durable figure holds yet — the turn in flight, or rows written after the daemon's read (a `…ThroughSeq` cut-off) — on top of the daemon's figure. Its own fold is a fallback only while the daemon has no figure at all.
- A new statistic ships with a daemon spec that pins it over rows outside any window or cap (a call past the listing cap, a turn older than the loaded page).
