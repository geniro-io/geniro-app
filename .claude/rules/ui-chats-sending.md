---
description: Chats page — sending, the message queue, Send now, not-sent messages, attachments and pasted files
paths:
  - "apps/ui/src/renderer/chats/follow-up-delivery*"
  - "apps/ui/src/renderer/chats/use-message-queue*"
  - "apps/ui/src/renderer/chats/queued-message-store*"
  - "apps/ui/src/renderer/chats/queued-strip*"
  - "apps/ui/src/renderer/chats/use-chat-run*"
  - "apps/ui/src/renderer/chats/not-sent-*"
  - "apps/ui/src/renderer/chats/message-composer*"
  - "apps/ui/src/renderer/chats/composer-placeholder*"
  - "apps/ui/src/renderer/chats/use-attachments*"
  - "apps/ui/src/renderer/chats/attach-files-button*"
  - "apps/ui/src/renderer/chats/use-file-attach*"
  - "apps/ui/src/renderer/chats/paste-file-paths*"
  - "apps/ui/src/renderer/chats/task-worktree*"
  - "apps/ui/src/renderer/chats/pending-send*"
  - "apps/ui/src/renderer/chats/team-root*"
---

# Chats — sending and the queue

**Sending and the queue:**

- The whole send/queue decision is `followUpDelivery`/`parkedReason` in `chats/follow-up-delivery.ts`, pinned row by row in its spec. The send path, button label, hover sentence and placeholder all read it.
- Principle: a message goes straight in when the agent will read it soon, and queues when the agent is busy with something that blocks reading.
- `sendFollowUp` queues when the agent is working or when the queue is non-empty. Never decide on `streaming` alone.
- Queueing behind an idle run kicks the drain. Never kick it while the agent is working.
- RUN_BUSY from the daemon means queue and retry. The daemon is the fact, and the renderer's `streaming` is only a belief. A Send-now it refuses draws the daemon's sentence on its row (`SteerStatus.reason`).
- The composer refuses no geniro command itself.
- Whether a unit is foreground or background is the CLI's own word, as announced by the daemon. Never guess it.
- A Stop leaves the queue standing on every surface, the hosted chats included: only `settleReleasesQueue` decides whether a settle drains. The head waits for its Send.
- A held turn (`holdingFor`) is not a working agent. The live announce drains once, on the transition into held. `queueMayDrainAfterReplay` treats a held run as drainable.
- A team whose manager has ended its turn (`rootsWorking = 0`) takes a message at once.
- While the agent is producing its reply, a typed message queues whatever background work is out. Background sub-agents and a detached command (`subagentsOut`, `shellsOpen`) park the agent only once its reply is over (its terminal item ended `streaming`, the turn is `held`, or — in a team — the daemon stopped counting the held lead in `rootsWorking`): the daemon counts them across turn boundaries, so they never decide a send mid-reply, here or in `queueMayDrainAfterReplay`. An agent blocked in its own wait on sub-agents is parked by the daemon's word, not the renderer's: claude's held turn, codex's `wait` (announced as `turn_held`), a manager's `await_agent` (`awaitingCalls`), each kept for a short gap after the wait returns so a polling agent is not read as busy between two waits.
- A send clears the composer first. `restoreUnsent` puts unsent content back into the thread it came from, never over newer typing.
- A message a turn accepted and then dropped (`unsentMessages` on a `system` row, paired by the user row's `deliveryId`) is drawn "Not sent" with Resend, quoting the CLI's `unsentReason` when it refused the message; the rules live in `chats/not-sent-messages.ts`. A `message_agent` "delivered" row whose `followUpId` a later "not delivered" row names draws nothing (`callFollowUpId`). Nothing is sent again unasked. Only a LIVE marker restores, and only into an empty composer (`restoreIntoEmpty`); a callee's message is never restored, since the composer feeds the run's lead; Resend goes through the queue with `followUpDelivery`'s kick, and a callee's message back to its own call (`callTargetOf`), never to the lead. A marker whose messages are all on screen draws nothing itself.
- Send waits for `useAttachments().reading` and for uploads (`attachBusy`). Each read and upload carries its owning thread.
- "Send now" checks the mid-turn channel of the agent the message lands in (the run's lead, `runLeadOf` over `RunDto.currentLead`), never `activeRun.agentKind` alone (it is null for team runs).
- A Send-now press POSTs `backgroundWork: 'ask'`. A message that would cancel running sub-agents (cursor, sub-agent sessions) is refused `FOLLOW_UP_CANCELS_SUBAGENTS`, which opens the confirm (`subagentCancelAsk`) with the daemon's sentence; confirming POSTs `'cancel'`, and the question goes when its message leaves the queue.
- The drain POSTs `waitForAnswer: true`. While a card a new turn would retire waits for the user, the daemon refuses it `RUN_AWAITS_ANSWER`: the message stays queued, no banner, and the answer's own turn ending fires the drain again. A Send-now press carries no such term, since pressing it is the user moving on from the card.
- Queue drag: call `preventDefault` on `dragover` first, then decide what to move. Never return early over the dragged row.
- The paperclip is an `<input type="file">`, which also works on a phone. A non-image file becomes its path. On a phone it is uploaded first (`POST /v1/chats/uploads`).
- A pasted non-image file becomes its path (`chats/paste-file-paths.ts`). Insert it with `execCommand('insertText')`. Give back a paste you cannot replace.
- A chat in a task's worktree re-creates it once on `INVALID_CWD` and resends — a message, a Retry, an Apply or an agent's button press (`chats/task-worktree.ts`; a press through `PressHooks.deliver`, the same seq and `clientMessageId`). That is the card's own chat, and any chat whose folder the card records as its `worktreePath` (an analysis of the card's thread runs there); the folder's last segment names the only card asked. While the worktree is cut again the message is drawn as the user's own row at the transcript's end (`chats/pending-send.ts`): per window, never persisted, counted in no statistic, gone at the send's settle or once the daemon's row is in the window.
