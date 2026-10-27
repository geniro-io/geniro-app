# apps/ui

The Electron app: main process, preload and React renderer (electron-vite). Project-wide commands, conventions and constraints are in the root `AGENTS.md`. Renderer styling and reuse rules are in `.claude/rules/renderer-*.md`.

**Contents**: [Renderer shell](#renderer-shell) · [Design system](#design-system) · [Chats](#chats) · [Workflows](#workflows) · [Settings](#settings) (incl. _Settings keys_) · [System notifications](#system-notifications) · [Sidebar](#sidebar)

---

Main process (git, task worktrees, **Daemon supervision**, **Terminal panel**, **LAN gateway**), app updates and security: `apps/ui/src/main/AGENTS.md`. macOS packaging: `.claude/rules/packaging-config.md`.

### Renderer shell

- The phone page is not a secure context: the gateway serves plain http. Use `renderer/random-id.ts`, never `crypto.randomUUID`, and `renderer/clipboard.ts`, never `navigator.clipboard`. eslint bans both direct uses.
- A new secure-context-only API passes every test and fails only on the phone.
- Stale bundle: `renderer/stale-bundle.ts` → `reloadForNewBundle` reloads once, from whichever of three places sees a chunk-load failure first: `vite:preloadError`, the root `ErrorBoundary`, or `boot-app.tsx`. A second page failing within 30s shows the error instead of looping.
- Phone layout (below `sm`) is pages under `components/bottom-tab-bar.tsx`.
  - Each detail page holds one marked browser-history entry (`components/use-phone-back-entry.ts`). Every way back goes through `history.back()`.
  - The shell's hash sync must pass `history.state` through `replaceState`, never `null`.
- The window never scrolls (`html, body, #root { overflow: clip }`). A full-screen view scrolls an outer pane and caps width with a separate inner column, never with one element.
- jsdom computes no layout. Specs pin the DOM fact that decides a layout (which element scrolls, the class, document order), never a measured position.
- Title bar (`components/title-bar.tsx`, one band above all columns):
  - `TRAFFIC_LIGHT_*` and `TITLEBAR_CONTENT_INSET` live in `shared/contracts.ts`, because main positions the buttons and the renderer reserves room for them. Re-measure before changing them.
  - `trafficLightPosition.y` and the bar's `h-11` move together.
  - The title bar is the only drag region (`.app-drag`). Any control inside it needs `.app-no-drag`.
  - The title is centred on the window, never measured from a column's width. Never put a flex `gap` on the bar row. The title bar is the one header band: no per-column header rows and no divider.
  - The debug log is ⌥⌘L only.
  - `chats/waiting-status.tsx` counts what waits on the user (asking, failed, unread); a press or ⌘J (`chats/use-next-waiting-shortcut.ts`) opens the next one. Window-wide chords go through `components/use-global-chord.ts`.
- A Settings note under a control is one line: what flipping it does, plus the one consequence nobody would guess.

**Board (`tasks/`):**

- Card edits are optimistic (`useBoard.updateTask`). Never build the panel's fields from the saved card alone.
  - In-flight edits are re-applied over reloads.
  - An answer older than a newer edit is ignored.
  - A refused edit is undone only in fields that still hold what it wrote.
- The New task dialog stages pictures and files. `useBoard.createTask` creates the card without the staged references, writes the pictures, repoints the references, then binds files.
- The dialog is hidden, not unmounted, so its reset on open must also clear staged phone uploads.
- The "cannot start" popover offers the board's run settings only for a blocked `kind` they can answer (`FIXED_IN_RUN_SETTINGS`); the board re-reads the queue after the soonest blocked `retryInMs` (`soonestRetryInMs`), re-armed on every queue answer, since nothing announces a hold lapsing.

**Stats (`stats/`):**

- Chart colours come from `stats/charts/chart-theme.tsx` only. The transcript's chart card reuses it.
- Line counts are measured in the renderer per repository root and branch (`use-line-snapshots.ts`), against a daemon-held baseline.
  - The reads (`getGitHead`, `getChangesTotals`) are `denyRemotely`, and the hook is silent on a phone.
  - A git check that merely failed answers `null`. Never replace a baseline over a timeout.
  - Before the daemon stops, main asks windows to flush in-flight measurements (`line-measurement-flush.ts`).
- `dayRangeTitle` reads local days. Never take the day from `iso.slice(0, 10)`.
- `formatUsd` is pinned to `en-US`.
- `formatPercent` never rounds up to a whole the value did not reach.

### Design system

The rules live in `.claude/rules/renderer-*.md`; start from `renderer-components.md`, which also holds the catalog-coverage rule. Main-process and tooling facts they do not cover:

- The theme is applied by main, with no IPC channel. `Settings.theme` is read by `main/native-appearance.ts`, which sets `nativeTheme.themeSource`. That one write themes the OS chrome and drives the renderer's `prefers-color-scheme`.
- `applyTheme` is the only exported way to apply a theme, because it also repaints the window `backgroundColor` (`watchSystemAppearance`). Never export the bare OS write.
- `createWindow` reads `resolvedTheme` → `ThemeDescriptor.windowBackground` from `shared/themes.ts` before any stylesheet exists.
- Storybook is dev-only and binds `127.0.0.1` explicitly (its default would serve the workspace over the LAN).
- `.storybook/preview.tsx` drives `theme/apply-theme.ts` and never sets `data-theme` itself. It installs the `window.geniro` stub before any other import.
- xterm and ANSI output are themed from tokens (`terminal-theme.ts`, `--ansi-*`). `ESC[90m` means dim and must never map onto `--ansi-black`. A copy of command output hands over `stripAnsi(text)`.

### Chats

**The transcript is a window.** A chat opens on its newest page (`Settings.historyPageSize`) and pages older through `beforeSeq`. Anything that describes the whole thread, a call conversation or an agent is read from the daemon, never folded from loaded `items` nor bounded by a capped listing (`.claude/rules/run-statistics.md`):

- Run state (`useRunState`, `GET /v1/chats/:runId/state`).
- Spend (`useChatTotals`, and the nodes route for workflows).
- The timeline, artifacts list, task-list words (`withDurableTaskLists`), shells (`withDurableShells`), delegates (`withDurableDelegates`), and node liveness (`withDurableNodeStatus`).
- Worked time and tool count, which take the daemon's figure alone where it has one.
- In each case the turn in flight is added on top (`withLiveCost`, `openTurns`).

A workflow run's window is its OWN flow only:

- Every window PAGE read passes `conversation=root` (the daemon answers a chat, whose agent calls no one, with the whole run). A root page anchors what each call's FOLDED card is drawn from. The tail catch-up and the reconnect replay read the whole run since a cursor.
- A row whose `inCall` is a call id (`isCallRow`; the run's own flow carries null) never joins `items`. Both places a row can arrive split on it into `callRows` — `use-run-stream.ts`'s `ingest` (live rows and the replay) and `use-chat-run.ts`'s `catchUpTail` — and the stream's `structure` folds the anchors and the call rows as one. An opened call card reads its own conversation through `CallConversationPager` (`call=<id>`). What it read is forgotten on thread open and close, and on return to the tail, whose root pages skipped the calls' rows written meanwhile.
- A reader about a call's turns, cards, shells or pages reads `transcriptRows` (the window plus every structure row filed under a call — a page's card anchors, live rows, an opened card's pages), never `items` alone.

Anchors and run state:

- Anchors (`GET …/items` → `{items, anchors}`) are kept apart from `items`, laid in only where the transcript is folded, and never drawn as rows.
- Live rows ask for anchors through `chats/use-live-anchor-asks.ts`, shared with the workflow dock.
- Whatever replaces anchors calls `forget`. A page landing after a live answer merges.
- Rows refused by `addItem`'s away-from-tail guard bring no anchors.
- Never rebuild a call heuristically from its later rows: it draws ghost cards.
- `useRunState` re-reads on open, reconnect, a structural row or a status announce, never on an activity phrase. The window supplies details; the daemon decides what has ENDED: a shell, delegate or call the page reads as running that began at or before the read's `throughSeq` and that the read says is over, is over (`withoutDaemonEndedShells`, `applyDaemonReadings` in `durable-transcript.ts`, `callEndedPerDaemon`). The same read carries each delegate's whole-run tool count, which `applyDaemonReadings` lays on its card with the delegate's rows above `throughSeq` added. The open turns' unanswered calls (`openToolCalls`) are folded in with the page, so a foreground command shows while the reader is elsewhere. Open requests off the tail are the daemon's too.

Jumps (search, global search, timeline, the Agents chip) — `chats/use-transcript-jump.ts`, DOM contract in `chats/jump-target.ts`:

- Every row a jump can land on carries its seq (`data-transcript-seq` / `data-row-seq` / `data-call-seq`), a second row it draws (`data-seq-also`, a tool row's result) and a page-unique `data-jump-key`; the mark is matched on the key, never the seq (a turn and its first row share one). The anchor drawing the hit wins, innermost first; only without one, the nearest start below it.
- The folds a row is drawn inside (tool group, tool row, long reasoning, sub-agent block, call card) are found from the transcript's STRUCTURE (`chats/jump-folds.ts`), never from seq ranges — interleaved delegates span each other's seqs. They are opened through thread memory, then the row is landed on.
- A row filed under a call is located (one-row read), the window paged to its card, the card and every card around it opened and read back to the row (`loadThrough`), then the row is marked inside the card.

One home for each concern:

- The per-run stream is `chats/use-run-stream.ts`, shared by the chat screen and the workflow dock.
- Run-row fields from `run_status` are read by `chats/run-status-row.ts`.
- The message queue rules are in `chats/use-message-queue.ts`. Only the chat screen persists queues (`queued-message-store.ts`, one key).
- `joinRun`/`leaveRun` both live in `use-chat-run.ts` (`activateRun`/`deactivateRun`).
- `Chats` stays mounted across nav switches. Read settings at the moment a run is created (`renderer/run-settings.ts` → `currentRunSettings()`, the one reader every renderer run start uses: chat, workflow run, analysis, a card's run, the builder's chat; main's autopilot normalises through the same `runSettingsOf` in `shared/contracts.ts`), never from cached state. Re-read lists such as fast actions when the screen becomes active again.

**Sending and the queue:**

- The whole send/queue decision is `followUpDelivery`/`parkedReason` in `chats/follow-up-delivery.ts`, pinned row by row in its spec. The send path, button label, hover sentence and placeholder all read it.
- Principle: a message goes straight in when the agent will read it soon, and queues when the agent is busy with something that blocks reading.
- `sendFollowUp` queues when the agent is working or when the queue is non-empty. Never decide on `streaming` alone.
- Queueing behind an idle run kicks the drain. Never kick it while the agent is working.
- RUN_BUSY from the daemon means queue and retry. The daemon is the fact, and the renderer's `streaming` is only a belief.
- The composer refuses no geniro command itself.
- Whether a unit is foreground or background is the CLI's own word, as announced by the daemon. Never guess it.
- A Stop leaves the queue standing on every surface, the hosted chats included: only `settleReleasesQueue` decides whether a settle drains. The head waits for its Send.
- A held turn (`holdingFor`) is not a working agent. The live announce drains once, on the transition into held. `queueMayDrainAfterReplay` treats a held run as drainable.
- A workflow whose manager has ended its turn (`rootsWorking = 0`) takes a message at once.
- While the agent is producing its reply, a typed message queues whatever background work is out. Background sub-agents and a detached command (`subagentsOut`, `shellsOpen`) park the agent only once its reply is over (its terminal item ended `streaming`, the turn is `held`, or — in a workflow — the daemon stopped counting a held trigger-fed agent in `rootsWorking`): the daemon counts them across turn boundaries, so they never decide a send mid-reply, here or in `queueMayDrainAfterReplay`. An agent blocked in its own wait on sub-agents is parked by the daemon's word, not the renderer's: claude's held turn, codex's `wait` (announced as `turn_held`), a manager's `await_agent` (`awaitingCalls`), each kept for a short gap after the wait returns so a polling agent is not read as busy between two waits.
- A send clears the composer first. `restoreUnsent` puts unsent content back into the thread it came from, never over newer typing.
- A message a turn accepted and then dropped (`unsentMessages` on a `system` row, paired by the user row's `deliveryId`) is drawn "Not sent" with Resend, quoting the CLI's `unsentReason` when it refused the message; the rules live in `chats/not-sent-messages.ts`. A `message_agent` "delivered" row whose `followUpId` a later "not delivered" row names draws nothing (`callFollowUpId`). Nothing is sent again unasked. Only a LIVE marker restores, and only into an empty composer (`restoreIntoEmpty`); a callee's message is never restored, since the composer feeds the trigger; Resend goes through the queue with `followUpDelivery`'s kick, and a callee's message back to its own call (`callTargetOf`), never to the trigger. A marker whose messages are all on screen draws nothing itself.
- Send waits for `useAttachments().reading` and for uploads (`attachBusy`). Each read and upload carries its owning thread.
- "Send now" checks the mid-turn channel of every agent the message lands in (`triggerFedAgentIds`), never `activeRun.agentKind` alone (it is null for workflow runs).
- Queue drag: call `preventDefault` on `dragover` first, then decide what to move. Never return early over the dragged row.
- The paperclip is an `<input type="file">`, which also works on a phone. A non-image file becomes its path. On a phone it is uploaded first (`POST /v1/chats/uploads`).
- A pasted non-image file becomes its path (`chats/paste-file-paths.ts`). Insert it with `execCommand('insertText')`. Give back a paste you cannot replace.
- A task's chat re-creates its worktree once on `INVALID_CWD` and resends (`chats/task-worktree.ts`).

**Run status:**

- `RunStatusKind` and `RUN_STATUS_META` (`chats/run-status.tsx`) are the one vocabulary for every surface.
- `held` and `needs-input` are derived in the renderer and never stored. There is no `idle`.
- `displayRunStatus` applies a fixed rank order. Rank 6 (background work over `completed` → `held`) is withheld from `agentRunStatus`, the reading the notification rules watch.
- `BlockStatus` is never printed verbatim. Translate it through `RUN_STATUS_OF`.
- `settled-status.ts`: only a live terminal item mirrors its status onto the run row. A replay takes one reading from its last item (`reconcileFromTail`).
- A `turn_complete` stamped `insideTurn` is not terminal. Never mirror it.
- `RunStatusEvent.noTerminalItem` lets `use-chat-run.ts` end `streaming` and drain the queue.
- A settle arriving after the open run's live terminal row ends `streaming` too, without a second drain (`liveTurnEndedRef`; `use-hosted-chat.ts` mirrors it): a stray `running` can land between the two. After-turn bookkeeping rows (`isAfterTurnBookkeeping`) do not count as the run resuming.
- A run settling is a moment, not a flag. `settleMomentOf` reads the last terminal item first and the row's `updatedAt` only as a fallback. `subagentSpokeSince` and `taskCardIsLive` use that moment. A sub-agent's own status (`subagentBlockStatus`) reads no run state at all: its rows, else the daemon's whole-conversation reading (`daemonSubagentReadings` + `applyDaemonReadings` in `durable-transcript.ts`), which is the only place a missing ending is resolved.
- A null activity means "working, nothing named". Both live rows fall back to the one `STANDING_ACTIVITY`. `WORKING_WORDS[0]` is its twin.
- Live clocks count from durable-row timestamps, never from their own mount.
- The chat live-plane key is `CHAT_LIVE_KEY` (`liveTextKey`), never the daemon's owner key `agent`. Node id is the discriminator.
- `chats/geniro-tool.ts` is the one place host tool names are matched. A composing card of an unknown kind draws nothing.
- While a turn runs there is one clock, the worked total, and no second elapsed-time readout beside it.
- Turn duration uses the CLI's own figure where one exists. A thread total is the sum of its turns, never `updatedAt - createdAt`.
- A workflow's header clock (`clockMs`) is one formula for any number of open turns: the union of working stretches minus `pausedSpans`, the time a card waited on the user with no background shell or delegate running. Both come from the daemon's totals route (`utils/active-spans.ts`). It is re-read when the run's `awaiting`, shells-out or delegates-out flip, or a row they are folded from lands (`movesPausedSpans`). Never fold them from loaded `items`.

**Calls, instances and delegates:**

- A workflow run's agents come from the run's snapshot (`GET /v1/workflows/runs/:runId/workflow`), never the library. The new-run trigger chip is the exception.
- A call waiting under its run's active-turn cap reads `queued`, never running — on its card, in the agents panel and in the shelf's Agents chip (`CallBlockEntry.queued`, folded from the executor's `queuedCall` row; its first status row ends it; off the page, run state's `RunCallState.queued`). `queued` is unsettled and is not working.
- A call continuing an earlier call's `thread` is the same instance. Both surfaces resolve chains through `resolveCallChains` and match through `callIds`.
- Never pool every instance's work into one list. Rows are filed by `callId`. Content whose call is not loaded becomes an inferred instance.
- A main conversation exists only when there is a `status` row with no `callId`. Never infer one by counting turns.
- Never time a wait from the agent's last row.
- The call-message queue is keyed by call block id, because call ids restart per pass. It retries only `CALL_MESSAGE_REFUSED`. A message row (`role === 'user'`) is never the block's summary or result.
- The prompt-cache badge threshold is a twin of the daemon's `CACHE_EXPIRED` rule, pinned by a spec.
- A delegate's generic title is its id tail. `resultIsOwn` is decided structurally, never by matching a CLI's prose. A `SendMessage` is not a delegation (`isAgentToolName`).
- Shells listed in the panel are the main thread's only, dropped at the item (`subagentIdOf`).

**Thread analysis** (`analysis-dialog.tsx`, `use-thread-analysis.ts`):

- A thread's analysis is never a sidebar row and never a search hit. Its home is its popup over the source (`AnalysisDialog`), where it is read, answered, applied and replaced; the Analyze button opens the popup when one exists, else the setup dialog, and marks it (tint; a dot while working or waiting on you). The popup and the setup dialog close when their thread is deleted (the analysis went with it).
- A direct link (`#chats/<id>`) or the processes panel can still open an analysis as the thread on screen; its header's "Analyzing: <source> ↗" chip (`analysisSourceOf`) is kept for exactly that way back.
- The popup and the builder's chat dock are one surface: `chats/hosted-chat.tsx` (`HostedChat`, transcript + composer + chips) over `chats/use-hosted-chat.ts`. Change a hosted-chat behaviour there, never in one frame.

**Run waterfall** (`chats/run-waterfall*.ts(x)`, the "Where the run went" popup, opened from the agents panel's control row straight into its full view):

- Every span, its `seq` (what "Open in chat" jumps to) and the critical path come from the daemon's waterfall route; the renderer never folds them from loaded `items`.
- `blocksCaller` (`run-waterfall-geometry.ts`) is a twin of the daemon's critical-path rule in `v1/agents/utils/thread-timeline.ts`: any call not `async` holds its caller. Change one, change the other.
- The full view reads ONE state (zoom window, selected mark, focused agent); the tables count a turn's time where it overlaps the window and its money where it ended (`run-waterfall-breakdown.ts`).

**Cards (agent-drawn payloads):**

- Each card kind has a twin parser (`*-payload.ts`) of the daemon's schema.
- Agent buttons (`action-chip.tsx`, `action-card.tsx`, `use-chat-actions.ts`): what is pressable is run state's `actions`, never a fold of the window. A press refused `RUN_BUSY` is retried by the hook (same seq, same `clientMessageId`) once the turn settles, never through the composer queue, which would send the text without recording the press. The shelf group sits after the task list, ahead of the turn-scoped chips. A workflow run presses through the workflow routes (the hook takes whichever API the open run needs; the chat route refuses a workflow run), and its busy refusals are asked again on `ACTION_RETRY_MS`, since its run state opens no turn. A button whose `publisher.agentLabel` is set (another workflow agent's) says so: `· <agent>` on the chip, `from <agent>` on the card, linking to its call's card, which it opens (`ChatActions.openCall`: the `call:<blockId>` thread flag, then a reveal, paging first when the card is off the window; the Agents chip only reveals). A stop button lists what it stops (`spec.targets`: command and pid, plus what these start by the press) on its card and in the chip's tooltip before it is pressed, and its status reads `stopped` or `already stopped` (`alreadyStopped`).
- A command action opens `CommandConfirmDialog` from the chip, the card and the overflow row alike (the confirm state lives in `useChatActions`: `press` only sets `confirming`; one dialog per surface in `ChatProviders`), showing the exact argv, one quoted token per argument, and the folder. Nothing is sent until "Run command". The card shows the command (`Runs:`) before and after the press and, once it ends, its last run's status (exit code or error) even while the button stays live — a failed or reusable command stays pressable — plus a folded `Output` with the tail (`outputTail`, drawn through `AnsiText`, fold kept per thread). Only a message press starts a turn (`pressStartsTurn`), so only it raises a surface's working flag (the builder dock's).
- `isCardEntry` (`transcript-groups.ts`) is the one predicate over card kinds. Never write a `'task-list' || …` chain.
- A new card tool also goes in `GENIRO_TOOL_NAMES`, which the compiler cannot check.
- Findings keep the agent's order.
- Charts key rows by position (`s0`, `s1`, …), never by series name. `null` stays a gap.
- Metrics colour a delta by stated sentiment, never by sign.
- The gallery loads through `LocalImageLoaderContext`. It does that sequentially and only while open, releases images on fold, and uses no lightbox of its own.
- Dynamic workflow: the roster is taken whole. A launch is recognised by a `workflow_info` row, never by tool name.
- `propose_patch` renders as an ordinary approval card (`diff-view.tsx` `editDiffOf`). Its tool-name literal is a twin.
- A plan or question row that cannot be parsed falls back to the permission body.
- `propose_workflow` draws `WorkflowProposalCard` from its `approval_request` row (`workflow-proposal-payload.ts`, twin of the daemon's `WorkflowProposalSchema` / `WorkflowDiff` / `WorkflowProposalOutcome`); an unreadable payload falls back to the permission body. Saved / not saved is the verdict row's `outcome`, never the agent-bound message. Its Approve gate scans every string the card can draw, raw (`proposalScanText`), the diff's old side included. The graph preview is `lazy()` (`workflows/workflow-preview.tsx` is the only chat-reachable importer of `@xyflow/react` and `elkjs`). The card stands across turns, so it counts as needs-input only while no turn streams (`standsAcrossTurns`, the daemon's `awaitingOf`).
- The plan and workflow cards share their note field and its send rule (`chats/verdict-note.tsx`); the hazard gate is `chats/text-hazard-gate.tsx`, shared with the permission card.
- A question card is drawn from the row's `questions`, never from a CLI's tool name. `secret` masks the field.
- `useOneShotVerdict` is the one verdict-timing contract.
- Only the latest task-list card shows its rows. Fold state derived from data takes a press override (`useThreadOverride`). Never seed derived open state into `useState`.
- Approval cards scan for text hazards (`chats/text-hazards.ts`):
  - Bidi or invisible characters gate Approve until acknowledged.
  - The tick resets when the content changes. Deny is never gated.
  - The banner names codepoints and never prints the character.
  - Join scanned parts with spaces, never newlines. Ordinary emoji are exempt.

**Artifacts** (`published-artifact.ts`, `artifact-frame.tsx`):

- The frame's sandbox is the root `AGENTS.md`'s (_Constraints_, the artifact page's outbound call). The page is served by the daemon, never put in `srcdoc`, and loaded with `referrerPolicy="no-referrer"`.
- Only theme tokens and height cross the frame, by `postMessage`, filtered on `event.source`.
- Key the frame by `${artifactId}:${version}`.
- A `show_artifact` row is never claimed into a call card (`UNCLAIMABLE_KINDS`): a callee's page is drawn in the main flow, and the newest-card sweep spans the whole run.
- The panel list comes from `GET /v1/chats/:runId/artifacts` and answers empty on a run mismatch.
- A saved file bakes in the theme and restates the CSP as `ARTIFACT_FILE_CSP`, a twin of the daemon's `artifact-page.ts`. Insert them into a parsed `<head>` (`DOMParser`), never by text splice.
- A saved file must look like the framed page. The daemon's raw reading (`renderArtifactDocument`) carries the frame's base style (font, padding, box-sizing, centring) but not its transparent ground, and the export supplies the ground.
- Links are opened by the host, only for `http:`, `https:` and `mailto:` (`shared/link-schemes.ts`). Main's `guardArtifactFrameNavigations` cancels any frame navigation away from the artifact route.
- Share (`artifact-share.tsx` over `use-artifact-sharing.ts`, provided as `ArtifactShareContext` by `Chats`): beside Save on the card and in the dialog header; null on a paired phone, which draws nothing. A press sends the current `themeVars()`. The link (key in its `#fragment`) is read from the daemon when the panel opens, never kept in the list — and only for a share that was uploaded (`sharedVersion > 0`). A share waiting on sign-in (`awaiting-sign-in`) tints the icon `text-warning` and shows "Sign-in required (<cli>)" with `SignInAction` (`components/sign-in-action.tsx` over `use-share-sign-in.ts`, polling like `use-cli-login.ts` but never sharing its wire) in the panel and as a strip under the card; the daemon retries after the sign-in and announces `shares_changed`, which re-reads the list (`daemon-client.ts` `onSharesChanged`). Settings → Sharing checks a place only on Check, never on open. Settings → Sharing (`settings/sharing.tsx`) edits the places, the agents switch and the auto-revoke window, and lists every shared page with the moment it was first shared, Copy link, Revoke and Revoke all.

**Shells** (`chats/shell-activity.ts`):

- Detached state comes from the daemon's `shell_open`/`shell_info` rows, never from a text match. `readLaunchHandle` stays strict and anchored at the start of the reply.
- A failed kill is not a kill.
- Foreground commands are gated on `isSettledRunStatus`. Detached commands are not.
- The whole gate lives in `Chats.tsx`'s `shellsByAgent`, and every count flattens that map.
- `shell_info` and `workflow_info` rows are skipped outright in `groupTranscript`.

**The RING is drawn from three sources** in strict recency order (`chatContextFigures`): the live delta, then `Run.contextTokens`, then the last settled turn of the loaded transcript. `useContextReadings` is the last fallback.

- Read the live value directly, never through `agents[0]`.
- `rememberRunContext` mirrors live readings onto the run-row copy, only when the value changed and is positive.
- A workflow's composer ring is its root agent's (`rootAgentOf` needs a trigger edge). Otherwise it is null.
- A node's ring order is `cardContextOf`. The nodes route is fetched on run open and reconnect only (`reconnectNonce`), and its map is cleared on entry.
- A geniro-performed compaction (cursor) invalidates earlier readings. It resets the fold (`endsContextHistory`), clears the live plane and the mirrored row, and the ring shows empty with `awaitingReading`.
- The context panel is fetched on open and never polled. On a workflow run every readout branch carries `nodeId`.
- Category colours are assigned by position, never by name.
- Money goes through `formatUsd` (a bound, for columns), `formatExactUsd` (an exact value, for standalone figures) or, for chart ticks only, `formatUsdAxis` (`stats/stats-format.ts`). Never add another format. A figure nothing measured is a dash or omitted, never `$0.00` or `0`.

**Composer and chips:**

- `directory-select` is the one directory chip.
- `config-dir-select` renders nothing (never a disabled chip) when the CLI's `configDirs[]` row names a reason. `EffortSelect` and `ContextWindowSelect` return null on an empty listing.
- `target-select`: a CLI this machine cannot run is shown disabled, never hidden. The current target is never refused.
- `BranchSelect` switches the checkout. `BranchValueSelect` only records a name.
- The composer's model and its axes are one control (`chats/model-settings-select.tsx`), with two levels. Do not go back to a row of separate chips.
- Axes show one loading row while listings load.
- Context windows and model parameters come from the CLI per (CLI, model), never from a table here. Choosing a model clears the window everywhere it is stored (`modelChangePatch`).
- Use `withModelParameter` for parameter edits. An inline spread writes `{id: undefined}`.
- Auto-compact bounds are twinned in `shared/contracts.ts`. `Settings.lastAutoCompactPercent` is one value, not one per CLI.
- Approval modes come from `GET /v1/capabilities` `approvals[]`, never from an allowlist of agent names. `requiresPass` and `withheld` modes are hidden. The current value is always kept.
- A mid-turn mode change refused with 409 `RUN_BUSY` shows `daemonErrorDetail`.

**Pull requests and changes:**

- A thread's pull requests are only those it opened or its CLI recorded it touching (the run wire's `pullRequests`, each marked `opened`; a task card shows only the opened ones), addressed by URL (`use-thread-pull-requests.ts` over `readPullRequestsByRef`). That hook is the only source for the panel, the sidebar and the shelf.
- A pull request's recorded outcome (`record_outcome`) is the daemon's `DisplayedPullRequest.outcome`, never folded from the window: the shelf chip draws its acceptance mark beside the number from it, and a `run_outcome` transcript row reads superseded once that outcome's seq is newer than its own (`RunOutcomesContext`). `daemon-client.ts` carries it through every run-status announce.
- A sidebar row names the thread's newest resolved pull request among those it opened, and a touched one only for a thread that opened none — never in place of an opened one that did not resolve (`rowPullRequestOf`).
- A ref GitHub could not answer still draws a row.
- The renderer replaces the run's list wholesale on each announce.
- Do not reintroduce a branch-scoped pull-request list.
- `keepFresherRows`: a pin, colour or pull-request list written without moving `updatedAt` is decided by the listing. So are the live readings (`awaiting`, `holdingFor`, the shell/sub-agent/call counts), unless an announce of them arrived while the listing was in flight: no write stamps them, and an announce's `at` always postdates the row's `updatedAt`.
- "Changed since this chat started" uses `upstreamBaseSince` and excludes what a pull brought in. The header names the ref and claims no cause.
- The changes chip and dialog also count the worktrees the thread's agents made (`use-run-work-folders.ts`). A worktree is the thread's only if all three hold: main lists it (`listWorktrees(cwd, startedAtMs)`: a linked worktree made after the thread started — birth of its `.git` link file — never the main checkout and never a geniro task worktree, the direct children of `worktreesRoot()`), and the run's own tool calls name it (`POST /v1/chats/:runId/named-paths`). Each is read as a work folder (`getChangesSince(…, true)`: from where its history meets the start, past what upstream already has). Found folders are only ever added; each lists in its own dialog section. Listings go through `worktree-list.ts` (see *Git* in `apps/ui/src/main/AGENTS.md`).

**Thread UI memory** (`chats/thread-ui-memory.ts`):

- Folds are remembered per thread, keyed by the row they belong to (`tools:<group id>`, `tool:<call id>`, …), never by an index.
- Only a press writes.
- Which hook remembers a boolean, in a thread or outside one: `.claude/rules/renderer-components.md` → _The one home for…_.
- Two things are deliberately not per thread: the context readout's drill-downs and the builder palette.
- The agents panel is always rendered when a chat is open and starts folded per thread. Nothing but its per-thread fold shows or hides it: no show/hide toggle, no header button, no auto-open on an artifact.
- The agents panel's column holds only what belongs to the thread: its agents, workflows, pull requests and pages. The run waterfall, the processes readout and the thread notes open in popups from its control row (and rail), never as sections in the column; their reads are gated on that popup being open (`onPopupChange`), never on the panel being unfolded.
- Read the MCP listing only when its disclosure opens (`mcpOpen`).

**Fast actions** (`chats/fast-action-bar.tsx`, `settings/fast-actions.tsx`, `Settings.fastActions`):

- An action is a name and a description, nothing else. A press appends the description to the message box. It sends nothing and touches no chip. Never add run setup to an action.
- `persistFastActions` calls `window.geniro.updateSettings` directly, not the screen's `persist`, which swallows the rejection the rollback needs.
- The editor refuses locally whatever `settingsPatchSchema` would refuse. That boundary throws on the whole patch.

**Run configurations** (`chats/run-config.ts`, `new-chat-button.tsx`, `run-config-picker.tsx`, `Settings.runConfigs`):

- Named new-chat setups. Applying one seeds the new-chat screen and switches the branch. It sends nothing.
- Never fold run configurations and fast actions together. Doing so once deleted users' saved configurations.
- One component (`RunConfigPicker`) and one key serve both the `+` dialog and the Settings pane. `onApply` separates them.
- Build the run from the applied configuration, never from composer state.
- A workflow target writes none of the per-CLI choices. A `null` through those setters deletes the remembered entry.
- A branch refusal is a partial success: amber, through `composerNotice`, with no worktree redirect.
- `chats/composer-values.ts` reads foreign settings strings. Import it, never restate it.

**Session picker and config profiles:**

- The session picker searches every profile on the daemon. The fan-out is in the renderer, because profiles live in `settings.json`.
- The profile is carried on the row, and `resumeSession` takes it from the row.
- `partialReason` names unreadable profiles and a hit `SESSION_LIST_LIMIT`. There is no client-side filter. Do not reintroduce a folder-scope filter.
- The picker's agent is its own. `sessionProfiles` collapses to the default profile for a CLI with no config directory.
- A `ConfigProfile` is `{ id, name, agent, dir, color }`, and the directory is its identity. Two entries may not name one directory.
- A profile is offered to its own CLI only.
- The palette union is spelled in `shared/contracts.ts` (not derived from `RunGroupColor`). `GROUP_DOT_CLASS` stays an exhaustive `Record`.

**Looks redundant, is not.** Check here before cutting:

- The task list renders in both the transcript and the agents panel. The user confirmed they want both.
- The shelf's Tasks, Sub-agents and Terminals chips restate panel counts on purpose.
- The chat-list row is four lines. Do not delete one.
- The tail `ResizeObserver` watches the scroller itself as well as its children, because a shrinking viewport fires nothing else.
- The composer shelf reserves its height (`min-h-7`). Anything thread-produced worth reaching is another chip there, never a new band. Shelf order is durable to volatile, left to right.

**Do not reintroduce:**

- Landing-view centring on the window.
- The run's folder in the composer: it belongs in the header.
- A horizontal timeline strip, or a timeline inside `subagent-block.tsx`.
- Always-visible controls for an absent axis.

### Workflows

- "Workflow" is the thing and "graph" is its shape. The noun rule is in the root `AGENTS.md`. The renderer screen is `workflows/`.
- **The daemon's `v1/graphs/` deliberately keeps its name**: it is the graph engine, and no user reads it.
- Library cards take activation from `NavListItem`. Never use a `div role="button"` with a nested delete button.
- Port counts are edges actually attached (`useEdges`), never `rules.length`.
- Every wire is drawn by `graph-edge.tsx`.
- `NODE_TYPES` / `EDGE_TYPES` live in `flow-types.ts`, shared by the builder and the read-only preview. Inside `GraphPreviewContext` a node card drops delete, the ports toggle and live validation (its handles stay, hidden, so wires attach) and shows its added/changed mark; an agent that runs unasked is ringed and named.
- `Workflows.openRequest` (a chat card's "Open in canvas") leaves an open canvas the way Back does: flushed first, and the "Leave without saving?" prompt when that fails, opening the request on Discard.
- `flowEdgeKind` reads an absent type as `data`, for persisted edges. `EDGE_TYPES` is keyed by the whole `EdgeKind` union.
- The palette has no folds. The agent is one tile whatever the CLI. Switching a node's CLI starts from that CLI's defaults.
- Never pair `line-clamp-*` with a `display` utility.
- `ConfirmButton`'s variant excludes `destructive` at the type level, because it arms itself.
- An instruction node never runs and has no `node_state`.
- Agent-node fields that reach argv refuse NUL only, because the same schema reads saved YAML.
- `node-validate.ts` mirrors every daemon refusal. Otherwise one bad field stops every later autosave.
- `useAgentVocabulary` resolves during render off its cache, never from effect-set state.
- Free-text model mode waits for a non-empty list.
- There is no model adopt and no effort adopt, because unset is a real answer.
- The inspector uses the composer's chips, never builder-only copies. Approval modes come from `approvals[]` with `plan` filtered out.
- The builder's MCP read is not gated on a press: its 4xx is the only signal of a bad config path.
- A node's MCP switches are its own `mcpDisabled` and write nothing the CLI keeps.
  - A switched-off name the profile does not list shows as an `off` row.
  - Switching CLI clears the list.
  - Pool members fetch under their own CLI and profile.

**What the builder must never lose** (pinned in `Workflows.spec.tsx`, which drives the real React Flow; never mock it):

- Closing the chat dock hides it and never unmounts it. Autosave is paused while the agent works.
- The post-turn re-read compares against the last load or save, never against the canvas.
- Delete and Backspace act only while the screen is on view (`deleteKeyCode` is null otherwise).
- Leaving waits for `flush`. A late save or re-read answer for another workflow is dropped.
- Every save quotes the `hash` the canvas was loaded or last saved at. A `WORKFLOW_CHANGED` refusal (an analysis changed the file) holds autosave and offers Reload, which replaces the unsaved canvas; nothing is written over the newer file.
- A wire to a missing node is dropped on open and named. A data wire that closes a loop is refused (`closesDataCycle`).
- After a socket reconnect, the dock reads back from the newest row held when the socket dropped. A turn ending is counted once, by row id. The dock holds anchors the way the chat screen does.
- `RunDto.awaiting` follows the three-state rule: absent asserts nothing, and `null` clears.
- `maxActiveTurns` (the "Change workflow" dialog's agents-at-once row: a switch — off is no limit of its own, the machine ceiling — and a `Stepper` from 1 to the ceiling, so no value outside the range can be entered) rides `WorkflowMeta` through `fromFlow`, `canvasSnapshot` (a required argument) and every save, like the description; dropping it from any one of them loses the cap or loops autosave.
- Agent pools are capped at the twin `MAX_AGENT_POOL_EXTRA_MEMBERS`. Call instances name their member (`CallBlockEntry.member`). Hand-offs above the page arrive as anchors.

### Settings

**Settings keys (`settings.json`).** `main/settings.ts` owns the file, and `shared/contracts.ts` holds `Settings`. Values whose vocabulary is the daemon's stay opaque strings here. The renderer validates them against the generated enum. `interface Settings` in `shared/contracts.ts` is the authoritative key list; this list covers the keys with special rules.

- Composer memory: `lastChatTarget`, `lastApprovalMode`, `lastAutoCompactPercent`, `projectFolder`/`recentFolders`. The Analyze thread dialog's last choice: `lastAnalysisConfig` (agent, profile, model, effort, approval — null and a choice saved before it had one read as auto-approve, never the composer's mode). `lastModels`, `lastEfforts`, `lastContextWindows`, `lastModelParameters` (`{parameterId: value}`), `configDirs` and `recentConfigDirs` are keyed per CLI.
- Hand-managed lists, three different features: `fastActions`, `runConfigs` and `configProfiles`. Never fold any two together, or into `recentConfigDirs`.
  - Nothing adds or evicts an entry, and order is preserved.
  - `readSettings` salvages each list entry by entry (`salvageList`, twin of `salvageCliRecord`) and re-applies the cap.
- `agentOptions`: `{<cli>: {<optionId>: on}}`, from capabilities `options[]`. It is snapshotted onto the run.
- `notificationsEnabled`: one switch for every notification kind.
- `archiveRetentionDays`: `null` by default. It arms a permanent deletion sweep (`POST /v1/chats/sweep-archived`), and the daemon learns the window from the client.
- `customInstructions`: see below.
- `replyLanguage`: the language every agent is told to reply in (`''` = not set), at most 64 characters (twin of the daemon's `REPLY_LANGUAGE_MAX_LENGTH`). Sent at every run start beside `customInstructions`.
- `theme`: read by main before any window exists, and enumerated in `settingsPatchSchema`. An unknown value falls back to `'system'`.
- `historyPageSize`, `checkForUpdates`, `remoteAccessEnabled`, `daemonInspect`, `cliPaths`.
- `keptSessionIdleMinutes`: how long a run's CLI and its MCP servers are kept after the last turn, 5–180, default 60 (a subscription's prompt-cache TTL), the same for chats and cards. The same window ends what the run's agents left running outside the CLI that attribution can reach (dev servers, watchers; not an orphaned system binary), with a note in the transcript (`apps/daemon/AGENTS.md` → Run processes → Idle). The bounds are twins of the daemon's (`chat.types.ts`). Every write that changes it is pushed to the daemon (`kept-session-config-push.ts`, through `onSettingsWritten`), as is every daemon start; the daemon holds it in memory.
- `sharing`: `{destinations, defaultDestinationId, agentsMayShare, autoRevokeAfterDays}` — where pages are shared to, whether agents may share (off by default), and after how many days the daemon revokes a page on its own (`null`, never, by default; counted from the first share). A custom (`command`) destination may carry `signIn: {login?, patterns?}` (login argv, and output phrases meaning signed out). Salvaged destination by destination (`salvageSharing`), and a broken `signIn` field by field, never costing the destination; the shape is a twin of the daemon's `ShareDestinationSchema` (`ipc-schemas.ts` restates its limits). Every write that changes it is pushed to the daemon (`share-config-push.ts` over `daemon-config-push.ts`, through `onSettingsWritten`), as is every daemon start. Desktop only.

Data-loss rules:

- Removing or renaming a key destroys what it held. `readSettings` keeps only known keys, and `writeSettings` rewrites the whole file. Migrate or export first.
- An unparseable file is copied aside to `settings.json.corrupt-<timestamp>` (0600) before any write. A file that cannot be read is never overwritten.
- Two clean breaks are on record: `agentOptions`, and question cards' `questions`. The next break migrates or exports first.

Sign-in:

- `use-cli-login.ts` is the one controller for an agent CLI's sign-in (a share destination's is `use-share-sign-in.ts`, kept apart from that wire on purpose), and `components/cli-login-progress.tsx` is the one panel for both. Signing in never opens a terminal.
- `CliLoginController.starting` is set synchronously before the await and cleared in `finally`.
- Sign-in buttons are disabled while starting, because a second press invalidates the first challenge.
- The flag belongs to the caller. `Chats` holds one controller for both flows.
- A server sign-in settles when the daemon sees it connect (`verifying`). The renderer never polls the listing itself.

Agents and MCP:

- An agent-specific setting lives in that agent's card (`AgentConfigListProps.agentSettings`), passed in by the caller. Onboarding passes none.
- Agent options are drawn from capabilities `options[]`. No card names a CLI's switch.
- MCP Add and Edit JSON write at user scope to the listing's profile. They never write to a folder or to a node's `mcpDisabled`.
- A JSON save carries the version it was read at. Read through a ref to the actions, because callers bind them inline.
- Plugin servers are `plugins[]` beside the server rows, never rows themselves.

Custom instructions:

- `customInstructions` saves through `use-debounced-persist.ts`. An unsavable value (control characters) is held on screen and never written. The timer handle is nulled.
- **Remove from existing chats** (`POST /v1/chats/forget-custom-instructions`) is an explicit press, never a side effect of clearing the box. It does not touch the snapshotted reply language.
- `replyLanguage` saves through the same debounced persist; a value over the bound or with control characters is held on screen and never written.
- The Settings screen reads the preamble and the per-CLI notes from `GET /v1/capabilities` (`hostPreamble`, `backgroundWorkNotes`), and the workflow inspector reads each agent node's block sizes from `POST /v1/workflows/instruction-sizes` (measured through the same parts); never restate either in the renderer.
- The host-preamble preview renders nothing until `hostPreamble` arrives.
- Every settings write is announced to every window (`onSettingsChanged`, `main/settings-changed-notify.ts`; no payload, a no-op on the phone bridge). The workflow inspector re-measures its instruction sizes on it, so an edit from the Settings screen or a paired phone reaches the figures.

Appearance:

- The picker does `persist({ theme })` plus `setThemePreference`.
- `theme` gets no `??` default: `readSettings` always merges defaults.

### System notifications

**System notifications** — the renderer decides when (`renderer/notifications/run-notifications.ts`, mounted from `Chats`), and `main/notifications/` decides whether and posts.

- The rules read display statuses, never the daemon's row.
- `notificationsEnabled` is read at the moment of posting.
- A run seen for the first time never notifies.
- A cancelled turn is not announced. A `failed` turn is.
- The open chat is skipped only while the window has focus and the Chats view is on screen.
- `notifier.ts` is the only file that touches a notification API. It uses Electron's `Notification`, never `node-notifier`.
- A turn ending with a command still running is announced provisionally and withdrawn (`retractNotification`) if the run goes back to work. Never guess with a timer.
- `notify_user` arrives as `RunStatusEvent.notify` and is posted once (`AgentNotice` id).
- `share-sign-in` is posted once per agent share that starts waiting on the user's sign-in (`shares_changed` with `signInRequested`, `useShareSignInNotifications`), never for the user's own press and never carrying the link.
- An open thread's ending is held (`settleOwed`) until its settle arrives, then posted or dropped by that settle's own flag.
- The rules read `runs + offScopeRuns`, because "absent" reads as deleted.

### Sidebar

- The unread mark is the daemon's: `attentionAt` later than `seenAt`. Both timestamps only move forward. Never compute it per window.
- Report "seen" only while the thread is actually watched (`useWindowWatched`).
- What a thread waits on the user for (`chats/waiting.ts`: asking > failed > unread > working, longest wait first) is read from the unfocused status and `useUnseenRuns`. It drives ⌘J, the title-bar count, board-card marks and the agents panel's card order, and never the sidebar order: a waiting thread does not move itself (user decision). ⌘J continues from the reading it last opened, because opening an unread thread drops it from the queue.
- Drafts, the queue and turn-end banners stay per device.
- Archive is the row action. Permanent delete exists only inside the archive. Workflow rows archive too.
- `refreshRuns` drops a stale generation, and runs one listing per scope at a time plus one queued; only a scope switch supersedes one in flight.
- The archive and `Show all` are paged (`chats/run-list-pages.ts`, `RUN_LIST_PAGE` rows per half, `limit` + `before*` cursor); the desk is never paged. A re-list keeps the depth already read. Rows one half has but the other has not reached yet are held back (`horizonOf`), and the list ends in "Load older chats".
- An unknown run is adopted by fetching that one row (`runId` on both listings), never by re-listing, and only on an announce of it doing something (a status or an activity). A pull-request, title or context announce never adopts.
- `placeRun` re-files a row on archive or unarchive, and `dropRun` is for permanent delete only.
- Row actions read `run.archivedAt`, never the scope.
- A scope switch keeps the open thread only if the new scope lists it.
- An archived chat is inert (`RUN_ARCHIVED`). Archiving a running chat asks first, because it cancels the turn.
- Groups: the auto-file rule matches the longest `autoCwd`, segment-wise, and a workflow claim outranks any folder claim. Adding a rule does not sweep existing chats.
- Deleting a group releases its chats (asked first).
- Dragging reorders; the daemon is told once, at `dragend`. The drop zone is the whole section. A drop that changes nothing writes nothing.
- A group header's state comes from its rows' badges, never from the daemon `status` column. `needsInput` is reported alongside `busy`.
- The sidebar row is one activatable element, so nothing inside it may be a control (labels, not chips).
- A workflow row previews its root conversation (`previewsThread`, twin of `ItemDao`'s `NOT_IN_A_CALL`).
- A background thread's preview comes from the `run_status` announce, not from items.
