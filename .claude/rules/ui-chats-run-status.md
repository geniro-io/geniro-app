---
description: Chats page — run status vocabulary and settling, live clocks and turn time, the context ring, money and model price display
paths:
  - "apps/ui/src/renderer/chats/run-status*"
  - "apps/ui/src/renderer/chats/settled-status*"
  - "apps/ui/src/renderer/chats/use-chat-run*"
  - "apps/ui/src/renderer/chats/use-run-state*"
  - "apps/ui/src/renderer/chats/run-state-readouts*"
  - "apps/ui/src/renderer/chats/durable-transcript*"
  - "apps/ui/src/renderer/chats/live-text*"
  - "apps/ui/src/renderer/chats/live-row*"
  - "apps/ui/src/renderer/chats/live-words*"
  - "apps/ui/src/renderer/chats/geniro-tool*"
  - "apps/ui/src/renderer/chats/agent-activity*"
  - "apps/ui/src/renderer/chats/turn-duration*"
  - "apps/ui/src/renderer/chats/use-chat-totals*"
  - "apps/ui/src/renderer/chats/chat-header*"
  - "apps/ui/src/renderer/chats/chat-context*"
  - "apps/ui/src/renderer/chats/context-*"
  - "apps/ui/src/renderer/chats/team-root*"
  - "apps/ui/src/renderer/chats/composer-shelf*"
  - "apps/ui/src/renderer/components/model-price*"
  - "apps/ui/src/renderer/stats/stats-format*"
---

# Chats — run status, clocks and the context ring

**Run status:**

- `RunStatusKind` and `RUN_STATUS_META` (`chats/run-status.tsx`) are the one vocabulary for every surface.
- `held` and `needs-input` are derived in the renderer and never stored. There is no `idle`.
- A team run's badge stays `running` while any call it started works, its leads idle or not. The readings the notification rules watch read a `running` team run whose leads have all ended their turns (`rootsIdle`) as `completed` (`teamLeadsDone`), and that run's ending is not held for a settle (`notificationSettling`): the Manager's reply is announced while its calls run on, unless the idle announce carries `hostTurn` (a turn only a running monitor's output woke), which counts as a quiet ending like a settle's. The daemon marks it unread on the same transition (`readAttention`, `rootsWorking` dropping to 0 over a `running` run), and announces a pass's terminal status before its leads go idle, so a pass ending is never read as a reply.
- `displayRunStatus` applies a fixed rank order. A background sub-agent out (`subagentsOut`) reads `running` over a held or a `completed` row; a background command out (`shellsRunning`) reads `held` over a `completed` row. Neither is passed to the notification readings (`agentRunStatus`, `unfocusedAgentStoppedStatus`), which the notification rules watch.
- `BlockStatus` is never printed verbatim. Translate it through `RUN_STATUS_OF`.
- `settled-status.ts`: only a live terminal item mirrors its status onto the run row. A replay takes one reading from its last item that is not after-turn bookkeeping (`replayTail`, `reconcileFromTail`): a late command or delegate ending, a button outcome, or geniro's compaction row (`conversationReplaced`), which the daemon writes after the compaction turn's end.
- A `turn_complete` stamped `insideTurn` is not terminal. Never mirror it.
- `RunStatusEvent.noTerminalItem` lets `use-chat-run.ts` end `streaming` and drain the queue.
- A settle arriving after the open run's live terminal row ends `streaming` too, without a second drain (`liveTurnEndedRef`): a stray `running` can land between the two. After-turn bookkeeping rows (`isAfterTurnBookkeeping`) do not count as the run resuming.
- A run settling is a moment, not a flag. `settleMomentOf` reads the last terminal item first and the row's `updatedAt` only as a fallback. `subagentSpokeSince` and `taskCardIsLive` use that moment. A sub-agent's own status (`subagentBlockStatus`) reads no run state at all: its rows, else the daemon's whole-conversation reading (`daemonSubagentReadings` + `applyDaemonReadings` in `durable-transcript.ts`), which is the only place a missing ending is resolved.
- A null activity means "working, nothing named". Both live rows fall back to the one `STANDING_ACTIVITY`. `WORKING_WORDS[0]` is its twin.
- Live clocks count from durable-row timestamps, never from their own mount.
- The chat live-plane key is `CHAT_LIVE_KEY` (`liveTextKey`), never the daemon's owner key `agent`. Node id is the discriminator.
- `chats/geniro-tool.ts` is the one place host tool names are matched. A composing card of an unknown kind draws nothing.
- While a turn runs there is one clock, the worked total, and no second elapsed-time readout beside it.
- A chat's open turn starts at the user's message, else at the agent's first reply, reasoning or tool call after the last ending (a stretch the CLI runs by itself; `opensOffTurnStretch`, twin of `ItemDao.openTurnStartedAt`), moved back to when the daemon saw it wake (`RunStateDto.turnStartedAt`, `withDurableChatTurn`). Its holds, ended and standing, are the daemon's (`turnHeldMs`, `turnHeldSince`); the live announce stands in only while the re-read is out.
- Turn duration uses the CLI's own figure where one exists. A thread total is the sum of its turns, never `updatedAt - createdAt`.
- A team's header clock (`clockMs`) is one formula for any number of open turns: the union of working stretches minus `pausedSpans`, the time a card waited on the user with no background shell or delegate running. Both come from the daemon's totals route (`utils/active-spans.ts`). It is re-read when the run's `awaiting`, shells-out or delegates-out flip, or a row they are folded from lands (`movesPausedSpans`). Never fold them from loaded `items`.

**The RING is drawn from three sources** in strict recency order (`chatContextFigures`): the live delta, then `Run.contextTokens`, then the last settled turn of the loaded transcript. `useContextReadings` is the last fallback.

- Read the live value directly, never through `agents[0]`.
- `rememberRunContext` mirrors live readings onto the run-row copy, only when the value changed and is positive.
- A team's composer ring is its lead's (`runLeadOf`: `RunDto.currentLead`, else the trigger's member). Otherwise it is null. A relay run also shows who leads as the shelf's `LeadChip`, and draws every member's rows with their identity (no `soloNodeId`).
- A member's ring order is `cardContextOf`. The nodes route is fetched on run open, on reconnect (`reconnectNonce`) and when a turn's end arrives (`arrivalMarks`), and its map is cleared on entry.
- A geniro-performed compaction (cursor) invalidates earlier readings. It resets the fold (`endsContextHistory`), clears the live plane and the mirrored row, and the ring shows empty with `awaitingReading`.
- The context panel is fetched on open and never polled. On a team run every readout branch carries `memberId`.
- Category colours are assigned by position, never by name.
- Money goes through `formatUsd` (a bound, for columns), `formatExactUsd` (an exact value, for standalone figures), `formatUsdRate` (a price per million tokens) or, for chart ticks only, `formatUsdAxis` (`stats/stats-format.ts`). Never add another format. A figure nothing measured is a dash or omitted, never `$0.00` or `0`.
- A model's list price is drawn by `components/model-price.tsx` alone (`ModelPrice`, or `modelPriceText` where only a string fits, a menu row's `hint`): from the reading's own price (`AgentModel.price`, `UsageGroup.price`, `ChatMetricsDto.modelPrice`), else `useModelPrice` / `useModelPrices` (`GET /v1/agents/model-price`, shared per client, agent, model and profile for a few minutes; the daemon's catalog is what refreshes hourly). A narrow row (an agent card, a pool slot, the waterfall's By model table) draws it `compact`. A picker row's `title` carries `modelPriceTitle`. An unpriced model draws nothing.
