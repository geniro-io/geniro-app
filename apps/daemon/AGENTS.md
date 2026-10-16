# apps/daemon

The NestJS loopback daemon the Electron UI spawns and supervises: CLI agent execution, workflow graphs and the call runtime, geniro's own MCP endpoint, the tasks board, stats and diagnostics. Project-wide commands, conventions and constraints are in the root `AGENTS.md`; the module layout is in `.claude/rules/daemon-module-structure.md`, adapters in `agent-adapters.md`, MCP tools in `mcp-tools.md`, queries in `database-queries.md`. This file holds only what those do not: the daemon's non-obvious invariants, by area.

**Contents**: Boot, process and storage · Runs and runtime columns · Agents: adapters · Agents: turns and off-turn work · Host tools · Question cards · Pull requests and task lists · Workflows and passes · Workflow call runtime · v1/mcp · Projects and tasks · Stats · Diagnostics and notifications · Handoff and sign-in · Importing CLI conversations · ACP and cursor transport · Auto-compaction · Agent caches and MCP configuration · Plan limits · Daemon endpoints (loopback)

---

### Boot, process and storage

- `auth/` holds the launch token, the per-node call tokens (`mint-token.ts` is their one source), `LoopbackTokenGuard` and `enforceWsHandshakeAuth` (the one Socket.IO handshake gate for every gateway).
- A call token is minted once per RUN, only through `CallTokenRegistry.ensure`. A kept CLI process presents the token it spawned with, so a re-mint locks it out of its own endpoint (silent 403s).
- `environments/`: prod is the base, dev spreads prod, test spreads dev; each is one `as const satisfies …` literal. `GENIRO_USER_DATA`, `GENIRO_PORT` and `GENIRO_IDLE_EXIT_MS` bypass `getEnv` (it boolean-coerces). `host` is a constant, never an env knob (127.0.0.1-only is a hard rule).
- `utils/process-identity.ts` is the one answer to "is pid N still the process I recorded" (ps start time). Never act on a bare `kill(pid, 0)`; a recycled pid is a stranger.
- One daemon per userData dir (`instance-lock.ts`). Takeover of a stale lock is rename-then-recheck, never delete-then-claim. Release on Nest's shutdown hook (not `process.on('exit')`), and only after `ProcessRegistry.drain` and `AgentSessionRegistry.closeAll`.
- Idle self-exit (`idle-shutdown.lifecycle.ts`) needs no WS client AND no in-flight turn, counting off-turn work (`workingOffTurn`). It SIGTERMs itself so hooks run, and is off unless `GENIRO_IDLE_EXIT_MS` is set (only `DaemonSupervisor` sets it).
- `crash-guards.ts` installs before Nest. An uncaught exception writes `<userData>/daemon-crashed` (twin of the UI's `daemon-pidfile.ts`), then SIGTERMs itself. Keep it latched (`shuttingDown`) and keep every handler body non-throwing; Nest runs hooks inside its SIGTERM listener, so a throwing hook re-enters.
- `db/nul-safe-sqlite.driver.ts`: MikroORM 7 inlines values into SQL and SQLite ends a literal at NUL, so the driver renders NUL as `char(0)`. Do not swap back to the stock driver. WAL is on; copying `geniro.db` needs `geniro.db-wal` too.
- Every child the daemon spawns registers with `ProcessRegistry`; every detached group is also journaled (`child-journal.ts`). An adapter spawns only through `start()` / `runCommand()`.
- **Run processes** (`utils/run-process-scan.ts`, `services/run-process-attribution.service.ts`): every run-scoped CLI is spawned with `runTagEnv` — `GENIRO_RUN_ID=<runId>` plus `GENIRO_RUN_OWNER=<currentRunOwner()>` (a hash of userData) — merged last so no adapter or caller env replaces it. `RunProcessAttribution` (over `attributeRunProcesses`) is the ONE answer to "which processes are this run's": tagged processes (this owner only; the env is the text AFTER the argv in `ps -E`) plus their descendants, each process in exactly one run. The usage readout (`RunProcessesService`: `detached`, then app-wide `leftover`), the reaper and the sweep all ask it, so what a thread shows as detached is what archiving it ends; its kept CLI trees end with `closeRun`. Readouts may share a reading up to `READOUT_SCAN_MAX_AGE_MS` old; kills always take a fresh one.
  - What is never attributed is decided by STRUCTURE, never by a program's name: the daemon and its ancestors, a run the daemon itself carries the tag of, pid ≤ 1, another uid, a process on a terminal (and what it runs) while that terminal is open, and `isOutsideAnyRun` (executables under `/System`, `/usr/libexec`, `/Applications`, `~/Applications`, and the container VM — matched by lima's own `/_lima/` directory under any home — the one named exception). Never the HOST of a terminal: codex runs commands on a pseudo-terminal, and a whole agent must not vanish behind one. Do not add name lists here: macOS offers no process containment to apps (no cgroups; coalitions are launchd's), and a name decides nothing reliably.
  - Known limits: a tmux an agent started is its thread's, so ending the thread ends it, shells the user opened in it included; a shared helper an agent first started (gpg-agent, watchman, a Gradle daemon) stops with that thread and restarts on demand; a job the user orphans from a session an agent started, after its terminal closed, carries the run's tag and is stopped with it. Nothing in the process table tells these from what the agent detached.
  - Kills (`RunProcessReaper`): explicit pids only, each re-confirmed by start time before TERM and KILL; nothing over `RUN_PROCESS_CAP` or when `ps` fails; never a run the registry holds a live agent under, asked after the scan; a reap the sweep queued re-asks the database that the run is still gone (`stillGone`); queued reaps share one scan; logs name the executable, never the argv.
  - Archive and delete reap through `RunTeardownService.endProcesses` (`closeRun`, then the reaper). `RunProcessSweep` (15 s after boot, then every 5 min) reaps what runs that are gone or archived in THIS database still run, never a run the registry holds a process for.
  - `ps` reads go through `runPs` (`LC_ALL=C`); the boot-time identity probe in `utils/process-identity.ts` pins the locale itself. `lstart` follows the locale, and an unparsed table reads as unreadable. macOS hides the env of its own platform binaries, and turbo's strict env mode strips the tag from its tasks, which is why descendants are included.
- Persist-then-emit: allocate seq, write the row, then publish.
- Env isolation is per adapter (`buildChildEnv`, `auth.isolatedEnvKeys` / `inheritedEnvKeys`); see `agent-adapters.md`.

### Runs and runtime columns

- `run_groups` (sidebar folders) are runtime state in SQLite, not YAML.
- Context readings (`Run.contextTokens` / `contextWindowTokens`, `NodeState`, `CallContext`) are LEVELS: a reading that omits a figure never clears it; a compaction clears it (`RunDao.forgetContext`).
- `CallContextDao` inserts only while the calling node still has a `node_state` row (an insert after teardown would orphan a row). The nodes route's call listing is capped (`CALL_CONTEXT_SNAPSHOT_LIMIT`).
- `workedMs` / `toolCalls` are TOTALS, written by real increments (`NodeStateDao.rememberWork`), never a read-modify-write. The `node_state` / `runs` column holds the CLI-reported time only. Delegate tool calls (`parentToolUseId`) are not counted.
  - A turn the CLI did not time (ACP), node or 1:1 chat, is measured by the wall clock from the agent's durable rows (`utils/wall-worked.ts`, twin of the renderer's `scanTurns`) and recorded one row per turn in `wall_turns` (`(runId, seq)` key, insert-or-ignore, never updated) by `WallWorkService`: live after each such `turn_complete` row (a chat's before its settle announce), and by a boot sweep retired by a versioned marker. No high-water mark: every catch-up records whatever its agent has unrecorded, so a turn durable late is still counted. `error` / `turn_cancelled` turns are not measured.
  - What is SERVED (nodes route `workedMs`, `RunDto.workedMs`, the settle announce) is CLI total + `wall_turns` sum (`servedWorkedMs`). `ChatTotals.workedMs` adds the run's whole `wall_turns` sum (`WallTurnDao.runSum`); the waterfall lanes and Stats stay CLI-only by contract. `wall_turns` is dropped with the run by `RunTeardownService`.
- `Run.workedMs` / `toolCalls` are written at every ending (complete, cancelled, error) and carried on the settle announce, never on activity announces. Null means not measured, never zero.
- `NodeState.polledSpend` is a per-EVENT ledger (the vendor revises charges): each poll replaces each event's figure; never a watermark. A node answers for its `sessionIds`, its callee `call_result` sessions, and their delegates (`spawnedConversations`).
- `Run.notes` is the user's alone and is never composed into a turn's instructions.
- `Item.inCall` is which call's card a row is drawn in (`utils/call-membership.ts`, twin of the renderer's claim pass): `''` is the run's own flow, NULL is not stamped yet. It is stamped at the one insert seam (`persistItemAndEmit`, through `ItemCallIndexService`). Older rows are stamped per run before a conversation read (`ensureIndexed`) and by a boot sweep off the ready path, retired by a versioned marker: a change to the rule bumps `CALL_MEMBERSHIP_VERSION`.
- `GET /v1/chats/:runId/items` pages one conversation with `conversation=root` or `call=<id>` (a workflow run only). A root page also anchors, for each call it shows or that runs across it, the call's `CARD_READS` rows (per-kind caps), task lists since the newest whole one, an open turn's tool calls, its newest row, own message and named tool calls, and what closes them (those tool calls' replies, its shells and delegates) — the twin of the renderer's folded call card and pairing readers — plus the `unanswerable` rows of its approval cards.

### Agents: adapters

- Every static CLI fact is one `AdapterConfig`; see `agent-adapters.md`. Lapsed-account markers are evidence-gated (`[]` until observed).
- claude, first-prompt MCP gate (`claude-turn.driver.ts`, `TurnDriver.awaitPromptReady`): the first prompt of a process waits on `mcp_status` until two identical readings show nothing `pending`. Read `mcpServers`, not `servers`. Only `pending` blocks. Exits: 2s empty grace, `refused` releases, 5s silence (`CLAUDE_MCP_READY_SILENCE_MS`, not timed while hooks run), 15s deadline with a notice naming the servers. A cancel during the hold drops the prompt; a throwing gate sends it anyway.
- claude `reload_skills` is sent only by the command-list probe (`commandListProbe`), never on a live chat.
- `withResponse` picks the AskUserQuestion answer field by question count; no caller picks it.
- cursor-acp's `mapMessage` throws by construction; `AcpSession` is its `TurnDriver`.
- codex (`codex app-server`, one process per conversation):
  - Every turn sends its full approval, sandbox, model and effort (codex keeps overrides).
  - A refused `turn/steer` always posts a notice quoting the message.
  - geniro's MCP endpoint rides the thread config as ONE dotted key `mcp_servers.<name>` (keeps the user's servers), token in `http_headers`.
  - `acceptEdits` auto-accepts a file change only if every path and move target is inside `cwd` by `utils/write-containment.ts` (both readings) and has no other hard links; anything else is a card.
  - Context window joins `sessionKey`.
  - One process holds a thread: a refused resume (`active writer`) retries ~2.5s, then FAILS naming the holder. Never start a fresh thread there (it would replace the run's session).
  - MCP listing is a dialogue over an ephemeral thread. Never `codex mcp list --json`. Only servers in the user `config.toml` get a switch.
  - Sub-agent spend (`CodexSubagentSpend`) is folded into the turn that ends and marked billed; stopped/failed turns carry usage on `turn_cancelled` / `error`.
- `services/agent-session.registry`: kept CLI processes, one per run key, separate from `ProcessRegistry` (which tracks turns). It must subscribe to `session.closed` (a dead session is not idle and would hold a slot).
  - Ceiling `sessionCeilingFor`: total memory / 8 / ~1GB, clamped [2, 16].
  - Eviction never takes a turn in flight, a parked card, or an entry with off-turn activity within `OFF_TURN_ACTIVE_MS`. That window must equal `DELEGATE_ROW_LEASE_MS`.
  - Off-turn events refresh (never arm) the idle timer (`touchOffTurn`).
  - A close that interrupted work writes one transcript row (`noteInterruptedSession`); other closes write none.
- MCP harvest is age-bounded (it shadows the live listing); skill harvest is keyed `(agent, cwd)`. MCP listing cache key includes `configDir`, the read runs under that profile's env, with a keyed single-flight (it launches the user's servers).
- `chat-metrics` composes only: it hands the adapter `{live, sessionId}` and each adapter answers from its own channel.
- `chat-title`: writes a title only while it is still exactly what this service derived (manual renames are permanent); checks ownership before any spawn. Do not reintroduce asking cursor for a title. claude's title ask is a throwaway `haiku` turn, MCP withheld, temp cwd, once per conversation.
- `WorkflowTitleBackfillService` runs once ever (marker file). Never make it repeat; it would erase user renames.
- `run-teardown` is the ONE delete teardown (cancel, wait, revoke tokens, purge rows with `softDelete` off, drop attachments and artifacts, announce `runDeleted`), shared by chat and workflow delete.
  - It never touches `usage_events`, `usage_activity` or `line_baselines`.
  - Only an ARCHIVED run's own CLI transcripts are deleted with it (`session-transcripts.service.ts`). It keeps a session another run names, or one that began before the run (an import). It never throws.
- `utils/`: nothing is named after a CLI. `CliSession.ask` must stay additive (control replies and events never consume each other's lines).

### Agents: turns and off-turn work

In `utils/spawn-cli.ts` unless noted.

- A `turn_complete` is HELD while a delegate it launched is out (`openWork`). Release on the last report, or at the silence deadline. Discard it if the main thread speaks again (`RESUMES_A_HELD_TURN`) or a follow-up is delivered. Only on a `session` stdin lifetime.
- For a CLI that announces session state, `idle` (claude `session_state_changed`) ends a held turn and writes off missed units. Do not reintroduce a grace timer after the last report.
- A follow-up written into a turn holds the turn until the CLI echoes it (`unconsumedFollowUps`, gated on `followUp.consumptionReported`). The held segment's usage is folded (`fold-turn-complete.ts`).
- Backgrounded commands never hold a turn; only `unit === 'agent'` does, and `'other'` counts as a shell.
- A foreground unit (`is_backgrounded: false`) is never announced as background work until a `backgrounded` patch arrives. It still enters `openWork`.
- `shell_open` / `shell_info` rows record detach and end. `announceShellWork` runs BEFORE `announceDelegateWork` and announces once per unit (`settledShells`).
- A delegate's own detached command (`ownedByDelegate`) gets no shell row, but it is filed under its delegate through its launching call's `parentToolUseId` (either arrival order). While one runs, the delegate's `completed` settle is held, not announced: claude reports a delegate completed at each turn end and restarts it when the command reports. The held settle is announced when the delegate's last command ends; if claude then restarts the delegate, it reopens at once (deliberate: waiting for the restart could leave it working for good). If the process ends first, the held settle is announced as `stopped`, figures kept. If the delegate is started again while its settle is held, the held settle is dropped. A never-ending command keeps its delegate working. These commands count in `shellsRunning`, so the process is not reaped under them.
- `restatesRunAsWorking` excludes `shell_open`, `shell_info`, `notice` and a delegate close; anything else from a settled run flips it back to `running`.
- **A CLI that reports a backgrounded command FINISHED** (cursor) is checked against the process table (`sweepDetachedShells`, gated by `shells.unreportedDetachReason`). Only ANSWERED execute calls, prefix match, fed back through `announceShellWork`; poll only while something is out.
- Stopping a foreground command (`ChatShellsService.killForeground`): attribute first (only processes under this run's live CLI, never the CLI itself), then match. Signal the whole tree; write nothing.
- **A background DELEGATE's ending** for cursor is written by the daemon. The ACP session watches the delegate's own transcript, located by its brief, born after launch, unclaimed (`cursor-delegate-transcript.utils.ts`).
  - A turn ending closes nothing it can watch. Do not reintroduce a turn-settle closer. Unwatchable delegates close with no outcome ahead of the completed turn's `turn_complete`.
  - A turn with watched background delegates it launched holds, then wakes the agent with their reports (`holdForDelegates`, `MAX_DELEGATE_WAKES`). `DELEGATE_HOLD_IDLE_MS` must stay under spawn-cli's 30-min silence deadline. While held, Stop is `withdrawHeldPrompt` and a message ends the hold.
  - A resumed delegate appends to its old transcript; the claim moves to the newest brief.
  - A session close closes every delegate still out as `stopped`; the boot sweep does the same for SIGKILLed daemons. The open set is folded from durable `subagent_info` rows, ranked like the renderer's `subagentBlockStatus` (twin).
  - codex sub-agents (`subAgentActivity`) close on whichever ending arrives first; no turn-settle closer.
- A bracketed delegate's off-turn steps are not the run working (`BackgroundWorkCounts.isDelegateOut`).
- A workflow run's stranded delegates and shells are closed by the EXECUTOR (`closeStrandedWork`), ahead of its terminal row. Every close carries its open row's node AND call id (`ownerFields`).
- `workflow_info` rows come only from roster-bearing `task_progress` lines; the anchor is emitted at `task_started` (the only line carrying the name).
- Every finished compaction is one row; with no summary the daemon writes `COMPACTED_WITHOUT_SUMMARY` (`compaction-rows.ts`). Delegate compactions are skipped.
- A turn never settles on a continuation's result (`turn_complete.continuation`), unless the continuation absorbed this turn's prompt (echo matched, `promptTaken`).
- Between-turn events (`handleBetweenTurnEvent`) are persisted exactly like in-turn ones, and a settled run goes back to `running`.
  - Exceptions: a CANCELLED run stays cancelled (rows still written); a run whose `running` this path did not write is left alone (`offTurnRuns`).
  - Main-thread `text_delta` / `thinking_progress` / `reasoning_delta` also flip it back (`restatusAfterOffTurnSignal`); `context_progress` never does.
  - An unbracketed delegate's rows take a lease (`DELEGATE_ROW_LEASE_MS`), not a latch.
  - A session close restores the badge (`settleAfterSessionClosed`), except during shutdown. A process dying on its own is a close too.
- The silence deadline does not run while a verdict is outstanding; `respondApproval` rearms on delivery.
- Only `cancelRequested` settles `cancelled`. Any other signal settles `failed`, naming the signal.

### Host tools

geniro's render and card tools (`report_findings`, `show_chart`, `show_metrics`, `show_comparison`, `show_gallery`, `show_artifact`, `propose_patch`, `propose_plan`, `notify_user`). Layout and wiring: `mcp-tools.md`. Brokers live in `v1/agents/services/` over `HostSinkBroker`.

- `HostSinkBroker`: the disposer is identity-checked and `deliver` never throws. Keep both in the base only.
- The tool result is a receipt; the row is the only copy of the payload.
- A card is attributed to a delegate only when the turn is held, exactly one delegate is open, and its launching call is known (`attributableDelegate`). Otherwise null; never guess.
- Positional payloads (`show_chart` series vs `labels`, `show_comparison` cells vs `options`): blank an unreadable entry, never drop it, and re-align on both sides (renderer twin). A gallery is a set; drop unreadable entries.
- `show_metrics`: figures are preformatted strings (never coerce); sentiment is stated, and an unknown value reads as absent.
- `show_comparison`: recommendation is matched to an option by name (case- and whitespace-insensitive).
- `show_gallery` carries paths only; the daemon never opens them, and the renderer reads them through the image route's guards. `MAX_GALLERY_IMAGES` bounds reads per call.
- `show_artifact`:
  - Framed `sandbox="allow-scripts"`, never `allow-same-origin`, never `srcdoc`, under the route's own CSP.
  - Caps refuse, never truncate. A refused page image refuses the whole page.
  - The serving key is registered with `registerSecret` at its mint site.
  - Workflow call-capable nodes publish too; publishers are dropped with the run, not at pass end.
  - Ids are the run's (`<runId>/<artifactId>`), whichever node publishes. A workflow page's row names the call its publishing conversation answers (`CallBroker.callAnsweredBy`, resolved once), and that call's envelope plus every ancestor call's still running lists it under `artifacts` (`notePublishedArtifact`, noted before the write so a call settling meanwhile still names it, undone if the row fails). A page row never fetches its call as an anchor (`anchorNeedsOf` / `unplacedStructureOf`), since it is drawn outside the call's card. The tool's run-wide wording keys on `ArtifactBroker.inWorkflowRun`, never on call registration (a data-only workflow registers no calls).
- `propose_patch`:
  - The call auto-approves; the Apply card shows even in `auto`. Caps refuse.
  - `applyHostPatch` writes only inside the run's cwd per `utils/write-containment.ts` (shared with codex `acceptEdits`): lexical and real-path, under both readings. It is rechecked at write time with `O_NOFOLLOW`; hard-linked targets are refused.
  - `old_string` must match exactly once. Filesystem errors go to the model as their `code` only (paths leave the machine).
- `propose_plan`: no `stale` outcome; a blank note is normalized to absent; caps truncate.
- `notify_user` writes no row; it publishes on `run_status`.
- Descriptions are audited as a set (`mcp-server.service.spec.ts`). `report_findings` asks to be preferred over claude's `ReportFindings`; `propose_plan` says to use either plan mode or this tool, never both.
- No graph node registers a findings/chart/metrics/comparison/gallery/notify sink; `show_artifact` is the one render tool nodes get.

**Thread analysis** ("Analyze thread"; `ThreadAnalysisService`, `POST /v1/chats/:runId/analyses`):

- An analysis is an ordinary chat whose `Run.analysisSourceRunId` / `analysisSourceSeq` name the thread it reads and the seq its reads stop at (the source's newest row when it was started). Its method is `taskInstructions` (`utils/thread-analysis-guide.ts`), never a plugin skill at run time.
- It belongs to its source, like the builder's chat to its workflow: `listChats` and chat search (`ChatSearchIndexDao.match` / `run`) never return it, `GET /v1/chats/:runId/analysis` finds it (`{analysis: null}` for none, newest wins), and there is one per thread.
  - A start replaces exactly the analyses that existed BEFORE it created its own, and only AFTER the new one has its brief: a failed start keeps the old one, and two racing starts never delete each other's.
  - Deleting the source deletes it (`ThreadAnalysisService` on `bus.allDeleted()`, whichever route deleted the source); what that misses (a daemon stopped before the announce, a failed delete) is swept at boot (`sweepOrphans`).
- Its four tools (`read_analyzed_thread`, `report_recommendations`, `mark_recommendations`, `save_workflow_change`) are offered only while an analysis turn runs: `ChatService` registers an `AnalysisBroker` sink per turn only when the run has a source. The sink carries the source and snapshot, so no tool takes a run id from the model.
- `read_analyzed_thread` pages ~22KB (codex cuts a tool result near 10k tokens): timing from `ThreadTimelineService` (the waterfall's UNCAPPED fold plus id-paired tool durations and the critical path, cached per `(runId, snapshotSeq, working)`, after the run's call membership is stamped), rows clipped at 2KB, one row in chunks. Images are collapsed (`collapse-image-blocks.ts`, twin of the renderer's export) and secrets masked before any cut; every answer leads with `HISTORY_RESULT_PREFACE`.
- `report_recommendations` refuses an evidence seq that does not exist at or below the snapshot, a workflow item for a plain chat, a duplicate id, and an id whose `W-`/`R-` prefix contradicts its target. The card's timing strip is measured by the daemon, never taken from the agent.
- An Apply (`POST /v1/chats/:runId/recommendations/apply`) is a user message carrying the selected items in full and `payload.apply: {cardSeq, ids}`; it is refused `RUN_BUSY` while a turn runs, never delivered mid-turn, and `ALREADY_APPLIED` for a card that already has one (the renderer reads "applied" from its window only). `save_workflow_change` (`WorkflowChangeService`, in `v1/graphs`) writes only `W-` ids in the NEWEST Apply (user messages read in seq order), refuses a hash drift, a deleted file and an invalid graph, and writes a timed backup first. It is not auto-approved.
- Timeline spans are clipped to the read's `[from, to]`; the critical path takes, at each step, the work still going latest before the cursor (an interval running past the cursor counts up to it); tool calls pair by node, call and id (ACP ids restart per session). Whether the source was working at the snapshot is recorded at the start (`Run.analysisSourceWorking`) and every read folds with it, so one snapshot always folds the same.

### Question cards

- A standing `ask_user_question` card belongs to the TURN, not the MCP call (`utils/standing-questions.ts`). An abandoned call DETACHES, an identical re-ask ADOPTS, an early answer is HELD for the next ask, and a reworded question is a new card.
- For a CLI whose client will not hold a call open (`AdapterConfig.hostQuestionDeferredReason`, cursor): the tool answers `posted` at once and the answer arrives as the next message. Do not reintroduce polling.
  - The card outlives the turn (`sweepNode` skips `deferred`) and is retired by a new turn (`sweepDeferred` → `unanswerable`).
  - Write the verdict row and clear `Run.pendingQuestion` BEFORE the answer message goes out.
  - One per run, rehydrated at boot (`rehydrateDeferredQuestions`); a different second question is refused.
- cursor's own `cursor/ask_question` is not used for `ask_user_question` (option ids only).

### Pull requests and task lists

- A thread's pull requests are read from its own transcript (`pull-request-capture`). Never key them by branch.
  - `Run.pullRequests` holds the ones it OPENED. Only these end a card on merge (`TaskMergeService`), count in Stats (`announceOpened`, the backfill) and stand as a card's result.
  - `Run.touchedPullRequests` holds the ones a conversation's CLI record names (`AgentAdapter.readSessionPullRequests`: claude's `pr-link` lines — created, pushed to, checked out, commented on, merged). Shown on the chat surfaces only: `readDisplayedPullRequests` merges both for the run wire and the run-status announce. A task card and `get_task` show the opened ones (`RunDao.pullRequestsOf`).
  - Transcript signal: a `…/pull/\d+` URL that ENDS a line (alone, or after whitespace or `=`; never a bare `:`, which is `grep -n`) in a `tool_result` whose paired call ran `gh pr create` in command position (prefix words walked back). A URL mid-line is a quotation.
  - A record has no row of ours: it takes the seq of the tool result its time falls on (`ItemDao.toolResultSeqAt`), so ordering stays seq-based.
  - Incremental: the marker advances even when nothing was captured. Errors are swallowed per run. No repeating re-scan sweep; a rule change bumps `PULL_REQUEST_SCAN_VERSION`, and a run scanned under another version is re-read from the start once.
  - Store identity only (owner, repo, number, url), never title or state.
- `task_list` rows: `mode` says snapshot vs patch and is never inferred; absent means patch. The run fold is keyed by node AND `callId` and skips delegate rows (`parentToolUseId`).
- What `v1/agents` exports is whatever `agents.module.ts`'s `exports` names.

### Workflows and passes

`v1/graphs/`: `workflow-store` (`*.geniro.yaml` under `<userData>/workflows/`), `graph-executor`, `call-broker`, `capabilities`.

- `calleeSummary` (`utils/callee-text.ts`) is the one line a caller sees about a callee: label plus `description`, never `role`.
- Node settings are resolved once at run start. An unusable `configDir` or `effort` is dropped with a system row (`DroppedNodeSetting`), never passed on or dropped silently. `effort` is a free string.
- A pass leaves its processes running. The registry never reaps one holding a detached command (`shellsRunning > 0`). Archive and delete end all of them (`endProcesses`: `closeRun` over `<runId>` and `<runId>::…`, then the reaper for what their agents detached).
- Workflow rows take seq from the shared `ItemSeqAllocator` (a kept process writes between passes).
- A library save may quote the `hash` it was read at (`baseHash`); a file changed since is refused `409 WORKFLOW_CHANGED`, never overwritten. The builder's autosave and an analysis's applied change both write the same file.
- The pass-end `skipped` sweep touches only nodes still `pending`. `prepareNextPass` resets only DAG-scheduled nodes, never call-only nodes with state.
- Workflow node auto-compaction: see Auto-compaction.

### Workflow call runtime

- The call token reaches a CLI in a 0600 `--mcp-config` file (claude), an HTTP header in `session/new` (ACP) or thread config (codex); never argv, never a file in the worktree.
- Admission is "has outgoing call edges". Do not reintroduce a cursor trust probe, a `.cursor/mcp.json` merge or a `cursorCalls` capability.
- No cap on a run's total calls (depth cap only).
- Silence watchdog (`CALL_SILENCE_DEADLINE_MS`): surfaces, never settles. It writes one `stalledCall` system row with its text under `message`. Suspended while the callee has a tool call open, is parked, or is held. Cleared on settle and in `unregisterRun`.
- A callee's kept process is keyed by its CONVERSATION (`<runId>::call:<first call id>`). A continuation while a call on it is live is refused `THREAD_BUSY`. Install the process closer after `startTurn`; rebind the off-turn sink every turn.
- A parked question's 30-min TTL is suspended while its owner is blocked; blockers are a set of named cards, not a count.
- Call state survives a restart via the transcript (`v1/agents/utils/call-seed.ts`). Ids continue past the highest persisted; never re-mint `call-1`.
- claude question-capable turns (callees and callers) spawn in ask mode with the daemon auto-approving plain permissions (bypass mode strips AskUserQuestion) — only for an `auto` node; an explicit `ask` node keeps the human card.
- cursor `cursor/ask_question` must never be declined `-32601` (cursor would replay it as permissions that `auto` approves). A free-text answer naming no option is sent as `skipped`.
- Waits: `await_agent` / sync `call_agent` are bounded at 80% of `mcp.toolCallDeadlineMs` and by `DEFAULT_AWAIT_TIMEOUT_MS`; never unbounded. A user message releases waits (`interruptWaits`). Unknown arguments are refused. Call tools carry `ALWAYS_LOADED_TOOL_META`.
- **Agent pool** (`WorkflowAgentNode.pool`): only calls use the pool, and the node's own conversation is member 1.
  - Hand-on only on a limit, a lapsed sign-in, or a failure before any tool call; never on cancel or mid-work.
  - A handed-on attempt writes no terminal row and retires the kept process.
  - `node_state` belongs to member 1; spend rows name their own member's agent and model.
  - `calleeSummary` never names a member's config directory (it goes to the caller's provider).
- `mcpDisabled` per node/member writes no CLI config and joins `sessionKey`; geniro's own server is never switched off.
  - claude: `--disallowedTools mcp__<normalized>`.
  - codex: overrides only for names its config defines (an unknown name fails `thread/start`).
  - cursor: throwaway `CURSOR_DATA_DIR` with symlinks into the user's store.
- `CALLEE_FAILED[<class>]` (`rate_limited` / `auth_expired` / `daemon_restart` / `crashed`): the message passes through `redactSecrets`. `resetsAt` stays verbatim. Patterns are per-CLI config and must never carry the `g` flag.
- `cancel_agent`: no card, ownership enforced by the broker (`UNKNOWN_CALL` otherwise), reason required. It cascades to calls made inside; finished work is never stamped cancelled. After the turn ended it answers `already_finished` unless work is still owed.
- `message_agent`: ownership as above; `CALLEE_PARKED` when parked; a message not yet takeable is queued, never refused. Undelivered messages are written as `outcome: 'undelivered'`.
- A call the asker owns that has already finished is refused `CALL_FINISHED` (`CallBroker.finishedCall`) by `message_agent`, `cancel_agent` and `answer_agent`, naming `await_agent` and `thread:` as the next moves; only ownership reads as `UNKNOWN_CALL`. A caller still working when its async call settles is told inside its turn (`tellWorkingOwnerFinished`), never while it waits on its own calls, and `told` stays false so `drainCaller` still wakes it. Its note, and the question twin's (`tellWorkingOwner`), carry the call that conversation answers (`inAnsweredCall`); without it the row is drawn in the run's own flow as a stray block.
- Cache facts (`list_agent_threads`) are a tool answer, never part of the "May call" block (it is hashed into `sessionKey`). `CACHE_EXPIRED` refuses a cold, >50% resume unless `resume_cold`; geniro's own continuations are never refused.
- Reset wakes (`scheduleResetWake`) schedule only from an instant `resetInstantFrom` can place exactly. They are persisted on `Run.resetWakes` and re-armed at boot. A walk is taken only when it schedules exactly the promised agents; otherwise a note is written.
- A callee turn ending while its own calls run is HELD inside the same call (`holdCall`). The `heldCall` row is a twin of the renderer's `transcript-groups.ts`. Wakes for a held conversation go to the hold (`wakeOwner`). `MAX_CALL_WAKES` bounds it.
- A caller is a conversation (`callerKey(nodeId, conversationId)`); everything the broker keys uses that pair. Never wake a node in a fresh process with no session.
- A superseded pass refuses calls `RUN_BUSY` before minting ids, and numbering continues.

### v1/mcp

- `McpController` serves `/v1/mcp/<runId>/<nodeId>[/<conversationId>]`; tools are composed per request from what that node can use.
- The module sits above `v1/agents` and `v1/graphs`; nothing imports it back. Permission predicates stay in `v1/agents/utils/host-*.ts`.
- History tools (`search_chats`, `read_chat_context`) are never auto-approved and carry no `readOnlyHint`. Results lead with the data-not-instructions line and pass `redactSecrets`.
  - One recorded exception, `read_analyzed_thread`: see `mcp-tools.md`.
- claude is never offered `ask_user_question` (it has its own).

### Projects and tasks

- `Task.folder` null means INHERIT the project's folder, resolved at read sites (Run press, `TaskQueueService`). Never snapshot it at create. Folders are canonicalized and checked where set.
- The autopilot queue split lives in `v1/tasks` (`TaskQueueService`, `TaskQueueController` keeps the projects path/tag/operationId) because of the module cycle. While armed it refuses workflow-targeted cards.
- Module direction: `TasksModule` imports `ProjectsModule`; `ProjectsModule` provides `TaskDao` / `LabelInstructionDao` rather than importing back. No cascades: `ProjectsService.remove` deletes tasks itself.
- `Task.position` is allocated past the column's live max, never from a count; only `reorder` renumbers (conditional per-card UPDATE).
- Label instructions go into `Run.taskInstructions`, a column separate from `customInstructions` (forget must not purge them). They are re-resolved on resume.
- `Task.runId` and `Run.taskId` are written together or not at all; `abandon` deletes the run it created.
- **The daemon runs no git**: Electron main makes worktrees and branches. `TaskRunsService` starts an ordinary chat. Two start guards: the synchronous `starting` claim and `assertNotAlreadyRunning` (asks the run).
- `TaskSettleService` observes only. A run completing moves nothing and writes no report; never automate that from the settle. The settle only maps `failed` → `failed` and `cancelled` → `todo`, and only for a card still `in_progress`.
- Board tools (`HOST_BOARD_TOOLS`) go to every endpoint holder; every write goes through `TasksService`. Run-owned fields are refused; there is no delete tool.
- `refuseUnattended`: a chat not in `auto` may not put a card in an armed intake, change any card on an armed board (except the working run moving its own card out of intake), set `approval: 'auto'`, or change an existing card's run configuration. Keyed on the column the card ends in. The executor auto-approves no host tool.
- A working run may move its card only to `TASK_AGENT_OWN_STATUSES`.
- Report screenshots are copied onto the card; rewrite the image destination by position. Keep existing copies (20-file cap).
- A cancelled card is marked `Task.stoppedAt` and never auto-restarted (`TASK_STOPPED_BY_USER`); only a Run press that starts it clears the mark.
- `work-finished` is announced only for a card in `done` with no run working. `reviveFailedCard` lifts only `failed`. `run_deleted` clears the edge, keeps the report and never touches the worktree.
- Stop cause (`utils/stop-cause.ts`, twin of the UI's `writeStopCause`): `main.ts` reads and deletes it once, before both reconciles, then runs `settleCutOffCards(null)`. `crash` / `unknown` mark interrupted cards stopped (`TASK_INTERRUPTED`); `quit` / `self-update` / `restart` continue unattended.
- `create_task` defaults a new card to `backlog`; never default one into an intake column — an armed project starts an agent on it within seconds.
- A reported merge (`POST /v1/tasks/:taskId/pull-request-merged`) moves only a card still `in_review`, only for a URL its run captured (else `TASK_PULL_REQUEST_UNKNOWN`); a card moved elsewhere is a no-op.
- A task file is bound by PATH, never copied; `DELETE /v1/tasks/:taskId/files/:attachmentId` drops the reference only and never deletes the user's file.

### Stats

- `usage_events` and `usage_activity` are append-only ledgers that outlive teardown, with dimensions denormalized at write.
- `v1/stats` observes `AgentEventBus` and never drives; nothing in `v1/agents` imports it.
- Ledger writes are native inserts, not flushes (a flush re-stamps loaded runs' `updated_at`).
- Boot backfills must stay idempotent (`(runId, seq)` unique, `dedupKey`).
- Polled spend: Stats reads it only from the ledger rows (`seq ≤ POLLED_SPEND_SEQ`), never from `runs`.
- The spend fold is `v1/agents/utils/usage-figures.ts`, shared; never copy it. No price means `costUsd: null`, never $0.
- Lines are measured by the desktop app per folder against one `line_baselines` commit. Day lines are growth past the series peak, never a client delta.
- `ClaudeSessionCostLedger` persists session totals to disk (`claude-session-costs.json`). A resume's seed is registered at spawn and read from the transcript's last `cost-state` at the new process's `system/init`, never at spawn (the replaced process writes its line as it exits). A read that finds no line keeps a known total, and leaves the process's first result untrusted.
- List prices come only from `ModelPriceCatalog` (models.dev, persisted to `model-prices.json`); never a hand-written price table. Provider is an adapter fact (`usage.listPrice`).

### Diagnostics and notifications

- `debug-sink` is a module-scope singleton (predates Nest). Every entry passes the one `redact` door. Secrets are registered at their mint site (`registerSecret`).
- `payload-preview` masks over a bounded window and masks the whole payload when two windows disagree. Never show a cut secret prefix.
- `agent-stdio` is off by default. Debug lines go to the `debug` room, never a broadcast.

### Handoff and sign-in

- `v1/handoff` resolves and never runs. Do not reintroduce a PTY mirror (`TerminalSessionsService` etc.).
- `configDir` travels as env (`HandoffTarget.env`); `shell-line.ts` / `open-terminal.ts` are twins.
- codex uses `fork` while geniro's process may hold the thread (`mayHold`).
- `v1/auth` sign-in runs under `/usr/bin/script`; the reap re-confirms each child and kills that child's own group too.

### Importing CLI conversations

- Every adapter applies the session query itself (`AgentSessionsInput.query`) or declares `contentSearchUnavailableReason`. Search only said text, window the snippet on the term, and state bounds in `partialReason`.
- claude sessions are read off disk through `mapClaudeMessage`. Compare folders canonicalized.
- cursor sessions are listed under a throwaway profile and imported as a COPY. History is read at creation.
- Prepare the import before the run row exists; the happy path writes no system row.

### ACP and cursor transport

- **The cursor transport**: each turn runs under a throwaway `CURSOR_CONFIG_DIR` seeded from the user's `cli-config.json` only (ACP model/effort changes persist into it).
  - Non-`auto` turns write `approvalMode: "allowlist"` and `autoAcceptWebSearch: false`; failing to write that fails the turn. Whether a turn asks is part of `sessionKey`.
  - Never copy or symlink `mcp.json`.
  - `acp-sessions` is a symlink to `<userData>/cursor-sessions`, never nested in `cursor-profiles` (swept at boot).
  - A refused `session/load` degrades to a notice plus `session/new`.
- **ACP instruction delivery** — the composed block is sent once per SESSION, re-sent only when its text differs from `AcpSession.deliveredInstructions`. `deliveredInstructions` is updated from the prompt written, or read back from the `session/load` replay (`readHostContext`).
- Model and parameter frames go ONE AT A TIME, each after the previous reply (`configSteps`); never pipeline. The context-window parameter must be applied before the prompt (`applyBeforePrompt`), released on refusal. Never map window sizes in geniro.
- Max Mode is written explicitly every turn (ON and OFF) from the snapshotted `Run.agentOptions`; null reads as the default (ON). Do not rebuild learned Max Mode window sizes.
- `ContextWindowStore` keys include the window choice. `AcpSession.currentModelId` is the agent's own or confirmed model, never the requested one.
- cursor context (`cursor-context-store.utils.ts`): open `store.db` read-only via `node:sqlite`, never write it. Find the block by shape; categories must sum exactly, else null. Never estimate from the transcript. Persist the last reading into `turn_complete`. Mid-turn re-reads are floored at 2s and published only on change.
- Mid-turn follow-up on cursor interrupts. Send `session/cancel`, await the stopped prompt's reply, then the new `session/prompt` (`interruptedPromptId`); never send the second prompt straight away (it becomes unstoppable). Parked requests are answered `cancelled` and withdrawn; open tool calls close as interrupted. The wait is bounded (`INTERRUPT_ACK_DEADLINE_MS`).
- `reasoning_delta` and `tool_compose` are ephemeral (`mapEventToItem` → null). `tool_compose` carries the tool name and a byte count only, never arguments; delegate frames are dropped in the mapper.
- Self-reported cursor failures (`AcpAgentFailureProtocol`) need both anchors (prefix and error class). They settle `error` INSTEAD of `turn_complete` and never reach `finalText`. Transient drops resume up to 3 times.
- On a failed request, open tool calls close `CUT_OFF_TOOL_RESULT`; watchable delegations are adopted, not relaunched ("do NOT launch these again").
- Sub-agent sessions: declare `clientCapabilities._meta.subagents` only under `_meta`. Route only ANNOUNCED child ids; drop a child with no readable launching call. Messages queue while a background sub-agent runs (`sendFollowUp` → false).
- A `pending` tool call with empty arguments is held until refined (`heldToolCalls`).
- One process per conversation. Never go back to one process per turn; do not reintroduce an instruction telling agents not to background work.
- `AcpSession` holds only state that outlives a turn (transport, pending replies, capabilities, session id, MCP servers, model, session reply, delivered instructions, and everything keyed by a protocol id). Everything else lives on a fresh `AcpTurnDriver` per turn.
  - Mode, model and parameters are re-applied per turn; a turn naming no mode restores the default.
  - Every turn emits its `session`.
- Stop is `session/cancel` with a 5s kill fallback. `cursor-agent acp` ignores EOF; the registry's `close()` kills the group.
- cursor offers no `acceptEdits`: a stored `acceptEdits` asks exactly like `ask` (`cursorAutoDecision` → null); never auto-approve under it.
- Model selection reads `configOptions` (`configId`, not `configOptionId`) or the legacy `models`. Pick the frame from what the agent advertised, never a version. `cursor-agent models` ids are never the picker source.
- `create_plan` / `generate_image` are declined `-32601`; `ask_question`, `task` and `update_todos` are answered. Do not reintroduce the legacy `-p` cursor adapter, its `.cursor/mcp.json` merge or its trust probe.

### Auto-compaction

- **AUTO-COMPACTION** — asked of the CLI where it has a control, performed by the daemon between turns where not. One number: `autoCompactPercent` (10–95, null = never) per chat or node.
- claude: `--autocompact <threshold + 33k buffer>` (not `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`). The window is the conversation's last reading (live, then row; the executor seeds `nodeWindows` from `node_state` each pass). It joins `sessionKey`; outside 100k–1M the flag is dropped. cursor has none.
- Between-turn rule (`utils/auto-compact.ts`): after a `completed` settle, it sends `/compact` through `sendMessage` and writes its row only once that has taken.
  - A geniro-command turn never re-arms it.
  - `compactingRuns` refuses follow-ups `RUN_BUSY` with a per-turn token.
  - Baseline: the first reading after a compaction; no re-compaction until regrowth (`AUTO_COMPACT_REGROWTH_FRACTION`).
  - A carried compaction retires (marks) the kept process.
- Workflow nodes compact right after the filling turn, inside the unit owning the session key (`launchNode` / `launchCalleeTurn` / `continueNode`), never before a resume and never inside `enqueue`. `compactingNodes` refuses follow-ups. cursor's carried summary is held per session key in memory.
- Never write `/compact` into a running turn's stdin.

### Agent caches and MCP configuration

- `ModelVocabularyStore` (`model-vocabularies.json`) is invalidated by `--version` in the entry, `forgetAgent` on account sign-in/out (with an epoch so in-flight answers are discarded), stale-after-1h refresh, and a 7-day expiry. Never file an answer that could not be obtained (empty list).
- **MCP config writes** — the deliberate exception to "geniro writes only its own files". Always through the CLI's own key, lock or mechanism:
  - claude toggle: `projects[<claudeProjectKey>].disabledMcpServers` in `~/.claude.json`, under `proper-lockfile` at `~/.claude.json.lock`. Atomic, mode-preserving, fsynced (`rewriteHomeConfig`); refuse an unparseable file.
  - cursor toggle: the CLI's own `mcp enable|disable` in the folder.
  - codex toggle: `config/value/write`, only for servers its user `config.toml` defines.
  - Plugin copy (cursor, `~/.cursor/mcp.json`): strict re-read, refuse unparseable or conflicting names, atomic fsynced write. No credential; nothing host-bound may read `${env:…}`.
  - Server definitions (`/v1/agents/mcp/config`, `/servers`): user scope of the listing's profile only. claude touches only top-level `mcpServers`; codex only through `config/batchWrite` (never TOML by hand). Saves carry the read version and are refused if it moved. Add values are registered with `registerSecret` before the CLI runs; nothing in a body is logged. `codex mcp add` is refused when the name exists.
  - claude's `mcp-needs-auth-cache.json` is the one CLI cache geniro edits: delete a server's key once it is seen connected; leave an unreadable record alone.
- An MCP change MARKS the kept sessions it reaches stale (`markStaleWhere`, scope per `mcp.changeReach`); never close them mid-turn.
- A server sign-in is `succeeded` only once the server is seen connected (`verifying` until then).
- The toggle's profile is part of the address; the write lands in the file the read came from.
- Clear Agent Cache (`POST /v1/agents/caches/clear`) forgets cached answers only: never the harvest stores or `ContextWindowStore` (measurements nobody can re-take), and it never re-probes a CLI.
- codex MCP config is read from the USER layer of `config/read {includeLayers: true}`, never the effective config (which adds defaults and plugin servers that would then be written into the user's `config.toml`).

### Plan limits

- **Plan limits are the ACCOUNT's**: the ledger (`utils/plan-limits-ledger.ts`) is keyed by CLI plus the account's config directory (the folder pin first, else the run's profile). A real reading beats a newer `estimated` one for 30 min. In memory only.

### Daemon endpoints (loopback)

The OpenAPI document at `/swagger-api` (source of `pnpm generate:api`) is authoritative for every route and shape; read the controllers for behaviour. Bind, public allowlist and token rules are in the root `AGENTS.md`.

Auth by prefix:
- Public: `/health`. `/v1/artifacts/*` is checked by the per-artifact `key` query (an iframe cannot send headers): one uniform 404 for every failure, `Referrer-Policy: no-referrer`, `?raw=1` matched as the literal `1`. `@ApiExcludeController`.
- Launch token (`LoopbackTokenGuard`): every other `/v1/*`, `/metrics`. `/swagger-api*` uses `swagger.guard`.
- `/ws`: handshake `auth` token (`enforceWsHandshakeAuth`).
- `/v1/mcp/<runId>/<nodeId>[/<conversationId>]`: that node's call token or the launch token.

Rules when adding or changing routes:
- Declare static segments (`forget-custom-instructions`, `sweep-archived`, `reorder-pinned`, `processes`, `reconcile`, `awaiting-merge`, `reorder`) before `:param` routes. Workflow slugs `runs` and `import` are reserved.
- Take query filters through a Zod DTO, never a bare `@Query` (an absent value lists everything; `fastify-qs` parses operators). List `scope` is an enum, never a boolean.
- `configDir` and `customInstructions` are snapshotted onto the run. `configDir` travels as env, never argv, and must exist; a CLI without the mechanism refuses it (`CONFIG_DIR_UNSUPPORTED`). Text reaching argv (custom instructions, label instructions) refuses control characters.
- A mid-turn message is told to the CLI first and written only once delivered; else `409 RUN_BUSY`.
- `archivedAt` is its own column, never `deletedAt`. Archive cancels only a `running` turn; an archived run refuses messages (`RUN_ARCHIVED`).
- `PATCH /v1/tasks/:taskId` never accepts `runId` / `worktreePath` / `branch`. Status moves are a database compare-and-set (`TaskDao.compareAndSetStatus`).
- One live project per folder, enforced in the service, not a unique index (soft delete).
- `GET /v1/chats/:runId/image` stays an image channel: extension checked first, regular file, size cap, canonicalized before stat, URLs refused.
- Retry refuses a working run BEFORE closing its session, and requires a session id.
- `shell-output` names a tool call, never a path.
- Run snapshot (`Run.workflowSnapshot`): unreadable is `409 WORKFLOW_SNAPSHOT_UNREADABLE`, never re-frozen.
- Never store merged/open state for pull requests; never date them by capture time.
- `/ws` counts (`holdingFor`, `shellsOpen`, `subagentsOut`) are announced on transitions; every path that ends one must announce. `run_status.status` is nullable (activity announces assert none). `runs_changed` rows carry 0 for `rootsWorking` / `awaitingCalls`. `task_changed` is a twin of the UI's `parseTaskChanged`; the renderer collects worktrees only off `reason: 'work-finished'`.

Destructive or irreversible routes (and one that only looks it — `DELETE /v1/tasks/:taskId/files/:attachmentId` drops a reference, never the file):
- `DELETE /v1/chats/:runId` — hard-deletes a chat run through `RunTeardownService` (chat runs only; reached from the archive).
- `POST /v1/chats/sweep-archived` — deletes chats archived ≥ `olderThanDays` (1 day–10 years) from `archivedAt`; one at a time, failures logged and skipped. The policy is the client's.
- `DELETE /v1/workflows/runs/:runId` — one workflow run's history (never the library workflow).
- `DELETE /v1/workflows/:slug` — removes the library workflow's YAML file.
- `DELETE /v1/workflows/:slug/chat` — discards the builder chat.
- `DELETE /v1/projects/:projectId` — the project AND its tasks.
- `DELETE /v1/tasks/:taskId` (soft delete), `DELETE /v1/label-instructions/:instructionId` — remove a card or a label instruction.
- `POST /v1/chats/forget-custom-instructions` — drops the snapshot from every run (leaves `taskInstructions`).
- `POST /v1/chats/:runId/archive` — cancels a running turn and closes its session.
- `POST /v1/chats/:runId/retry` — closes the kept session (refused while working).
- `POST /v1/chats/:runId/shells/kill` — signals the agent's command tree.
- `PUT /v1/agents/mcp`, `PUT /v1/agents/mcp/config`, `POST /v1/agents/mcp/servers`, `POST /v1/agents/mcp/plugin-servers` — write the user's own CLI config (see MCP config writes).
- `DELETE /v1/groups/:groupId` releases its runs; it never deletes chats.
