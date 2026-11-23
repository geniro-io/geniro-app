---
description: Chats page — the transcript window, a team run's own flow, anchors and run state, jumps, and the one home of each concern
paths:
  - "apps/ui/src/renderer/chats/**"
  - "apps/ui/src/renderer/run-settings*"
---

# Chats

**The transcript is a window.** A chat opens on its newest page (`Settings.historyPageSize`, capped at `REMOTE_HISTORY_PAGE` in a browser through the gateway: `App` passes `transcriptPageCap`) and pages older through `beforeSeq`. Anything that describes the whole thread, a call conversation or an agent is read from the daemon, never folded from loaded `items` nor bounded by a capped listing (`.claude/rules/run-statistics.md`):

- Run state (`useRunState`, `GET /v1/chats/:runId/state`).
- Spend (`useChatTotals`, and the nodes route for teams).
- The timeline (read only while the Progress window shows its Timeline tab, `use-chat-timeline.ts`'s `enabled`), artifacts list, task-list words (`withDurableTaskLists`), shells (`withDurableShells`), delegates (`withDurableDelegates`), and node liveness (`withDurableNodeStatus`).
- Worked time and tool count, which take the daemon's figure alone where it has one. A call card's clock is the daemon's `callFigures[].clock`, continued over the rows above its `throughSeq` (`chats/call-clock.ts`, twin of the daemon's `utils/call-clock.ts`): the call's open time, its waits on its own monitors and calls included and its waits on the user left out, so it runs while the card says `waiting` and is never replaced when a turn lands.
- In each case the turn in flight is added on top (`withLiveCost`, `openTurns`).

Opening a thread draws it in ONE frame:

- The transcript draws only "Loading conversation…" until the first page, the run state (`useRunState`'s `loaded`) and, on a team run, the first node readings have answered (`threadOpening` in `Chats.tsx`) — once per open: a drawn thread never goes back to the placeholder. Rows and live text that arrive meanwhile are drawn with the page, and their anchor asks wait for it (`useLiveAnchorAsks`' `hold`). Nothing pages older while it waits.
- The open lands on the tail in a layout effect, so no frame is painted at the top of the page.
- The whole-run reads (nodes, totals, timeline, artifacts, team notes, shares) start once the room join has settled (`joinedRunId`) and re-read on rows that ARRIVE after it — live or replayed (`arrivals`, `chats/arrival-marks.ts`) — never on a fold of the window, whose first page would re-read everything the open just read.

A team run's window is its OWN flow only:

- Every window PAGE read passes `conversation=root` (the daemon answers a chat, whose agent calls no one, with the whole run). A root page anchors what each call's FOLDED card is drawn from. The tail catch-up and the reconnect replay read the whole run since a cursor.
- A row whose `inCall` is a call id (`isCallRow`; the run's own flow carries null) never joins `items`. Both places a row can arrive split on it into `callRows` — `use-run-stream.ts`'s `ingest` (live rows and the replay) and `use-chat-run.ts`'s `catchUpTail` — and the stream's `structure` folds the anchors and the call rows as one. An opened call card reads its own conversation through `CallConversationPager` (`call=<id>`). What it read is forgotten on thread open and close, and on return to the tail, whose root pages skipped the calls' rows written meanwhile.
- A reader about a call's turns, cards, shells or pages reads `transcriptRows` (the window plus every structure row filed under a call — a page's card anchors, live rows, an opened card's pages), never `items` alone.

Anchors and run state:

- Anchors (`GET …/items` → `{items, anchors}`) are kept apart from `items`, laid in only where the transcript is folded, and never drawn as rows.
- Live rows ask for anchors through `chats/use-live-anchor-asks.ts`.
- Whatever replaces anchors calls `forget`. A page landing after a live answer merges.
- Rows refused by `addItem`'s away-from-tail guard bring no anchors.
- Never rebuild a call heuristically from its later rows: it draws ghost cards.
- A call row whose card is not in the fold yet (a live row ahead of its asked-for start) is drawn nowhere, never as its callee's block in the run's own flow (`isUnplacedCallRow`); only `UNCLAIMABLE_KINDS` stay in that flow.
- `useRunState` re-reads on open, reconnect, a structural row or a status announce, never on an activity phrase. The window supplies details; the daemon decides what has ENDED: a shell, delegate or call the page reads as running that began at or before the read's `throughSeq` and that the read says is over, is over (`withoutDaemonEndedShells`, `applyDaemonReadings` in `durable-transcript.ts`, `callEndedPerDaemon`). The same read carries each delegate's whole-run tool count, which `applyDaemonReadings` lays on its card with the delegate's rows above `throughSeq` added. The open turns' unanswered calls (`openToolCalls`) are folded in with the page, so a foreground command shows while the reader is elsewhere. Open requests off the tail are the daemon's too.

Jumps (search, global search, timeline, the working-agents card) — `chats/use-transcript-jump.ts`, DOM contract in `chats/jump-target.ts`:

- Every row a jump can land on carries its seq (`data-transcript-seq` / `data-row-seq` / `data-call-seq`), a second row it draws (`data-seq-also`, a tool row's result) and a page-unique `data-jump-key`; the mark is matched on the key, never the seq (a turn and its first row share one). The anchor drawing the hit wins, innermost first; only without one, the nearest start below it.
- The folds a row is drawn inside (tool group, tool row, long reasoning, sub-agent block, call card) are found from the transcript's STRUCTURE (`chats/jump-folds.ts`), never from seq ranges — interleaved delegates span each other's seqs. They are opened through thread memory, then the row is landed on.
- A row filed under a call is located (one-row read), the window paged to its card, the card and every card around it opened and read back to the row (`loadThrough`), then the row is marked inside the card.

One home for each concern:

- The per-run stream is `chats/use-run-stream.ts`.
- A conversation drawn outside the chat screen — the builder's chat dock, a thread's or a team's analysis popup — is the chat screen itself: `Chats` with `hosted` (`chats/hosted-thread.ts`). Its run list is the one run the surface's `open` answers (`useChatRun`'s `pinned`), and it draws the thread alone: no list, no new-chat composer, no notifications, archive sweep, global search or Analyze. The surface gives its header controls, empty text, composer label and queue scope, and is told back through `onBeforeSend` (before every turn it starts: a message, a button press, a recommendations Apply, a Retry — `startHostedTurn`), `onWorkingChange`, `onAwaitingChange` and `onTurnSettled` (as a turn's ending arrives, before a queued message leaves behind it: `useChatRun`'s `onTurnEndRef`). `AnalysisDialog` takes the chat screen as `renderThread`, so the two modules do not import each other. Never write a second chat surface; a hosted surface that needs something is given it through `HostedThread`. The one exception is a call's Show all popup (`call-conversation-dialog.tsx`), whose scope is one call rather than a run, with no composer: its foot is the call card's own (`CallConversationFooter`, the message box and figures `CallBlock` draws).
- Run-row fields from `run_status` are read by `chats/run-status-row.ts`.
- The message queue rules are in `chats/use-message-queue.ts`. Every queue persists (`queued-message-store.ts`): the chat screen's under one key, a hosted conversation's under its surface's own (`HostedThread.queueScope`), so closing the dock or a popup, or a reload, loses nothing — it goes out once the surface is back and its agent is free.
- `joinRun`/`leaveRun` both live in `use-chat-run.ts` (`activateRun`/`deactivateRun`), which holds one join of the open run (`heldRoomRef`). `DaemonClient` counts joins per run, so several chat screens share the socket's room and it is left only when the last one lets go.
- The chat screen's composer text is a store (`chats/composer-text.ts`), never state on `Chats`: the field subscribes to the text (`MessageComposer`'s `text`), the screen only to facts it draws (`useComposerTextFact`: is there text, the `/` query), and send paths read `get()` at the press. Typing must not re-render the screen (pinned in `Chats.spec.tsx`).
- `Chats` stays mounted across nav switches. Read settings at the moment a run is created (`renderer/run-settings.ts` → `currentRunSettings()`, the one reader every renderer run start uses: chat, team run, analysis, a card's run, the builder's chat; main's autopilot normalises through the same `runSettingsOf` in `shared/contracts.ts`), never from cached state. Re-read lists such as fast actions when the screen becomes active again.
