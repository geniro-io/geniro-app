# Changelog

What changed in each Geniro release, newest first. The app shows it in Settings → What's new, and after an update.

A change not released yet is one file in `changelog/unreleased/` (format and rules: `.claude/rules/changelog.md`). The entries up to 1.317.3 were taken from the pull request titles.

## 1.317.3 — 2026-11-23

### Fixed

- Tell agents a named page style is not a fixed theme

## 1.317.2 — 2026-11-23

### Fixed

- Ship no Intel-only binaries in the macOS app

## 1.317.1 — 2026-11-23

### Improved

- Anchor a call card's tool readings only while its turn runs
- Open large threads in one frame without re-reading on first page

### Fixed

- Let codex's built-in Apps server be switched off
- Leave an agent worktree's unadded files out of the changes chip

## 1.317.0 — 2026-11-23

### New

- System analysis in Settings and a flag tool for every agent

### Fixed

- Let the context readout answer while a codex agent works

## 1.316.6 — 2026-11-23

### Fixed

- Ask a team run's title under the pool member that actually ran

## 1.316.5 — 2026-11-23

### Fixed

- Make the plan limits refresh visibly answer and stop lighting up the composer

## 1.316.4 — 2026-11-22

### Fixed

- Let a swipe over an artifact scroll the chat on a phone

## 1.316.3 — 2026-11-22

### Fixed

- Give in-app browser tabs a context menu and keep their keyboard focus

## 1.316.2 — 2026-11-22

### Improved

- Run unit tests without per-file isolation

## 1.316.1 — 2026-11-22

### Improved

- Stop daemon edits from re-running the UI's type-check and tests

## 1.316.0 — 2026-11-22

### New

- Let a team member start a callee in a subfolder of the chat's folder

## 1.315.1 — 2026-11-22

### Fixed

- Find failed-then-fixed tool calls in claude threads for lessons

## 1.315.0 — 2026-11-22

### New

- Show what extracting lessons costs and does, in a background-processes control

## 1.314.1 — 2026-11-22

### Fixed

- Let a finger swipe on a stage graph scroll the page on a phone

## 1.314.0 — 2026-11-22

### New

- Command center graph always shown, manager chat in a floating window

## 1.313.0 — 2026-11-22

### New

- Wake the command center manager on a finish only for threads it watches

## 1.312.0 — 2026-11-22

### New

- Continue team runs, chats and calls after a self-update or restart

## 1.311.2 — 2026-11-22

### Fixed

- Keep the reading place when older messages load into a turn

## 1.311.1 — 2026-11-22

### Fixed

- Wait for the avatar picker to finish before the autosave wait in Teams.spec

## 1.311.0 — 2026-11-22

### New

- Keep a waiting team lead's prompt cache warm

## 1.310.1 — 2026-11-22

### Fixed

- Show a team member's compaction and drop the reply it abandoned

## 1.310.0 — 2026-11-22

### New

- Read each analysed pull request's GitHub life after the team said done

## 1.309.1 — 2026-11-22

### Fixed

- Keep a question card standing when a codex turn ends before the answer

## 1.309.0 — 2026-11-22

### New

- Tell a claude agent when its pre-question text reached the user only as a summary

## 1.308.0 — 2026-11-22

### New

- Attach images to the analysis focus and keep its dialog steady

## 1.307.1 — 2026-11-22

### Fixed

- Stop showing the processes-stopped notice when a card's work is finished

## 1.307.0 — 2026-11-21

### New

- Let agents delete board cards with a delete_task tool

## 1.306.1 — 2026-11-20

### Fixed

- Keep a held call open through an off-turn stretch

## 1.306.0 — 2026-11-20

### New

- Pick a team analysis's runs by period

## 1.305.1 — 2026-11-20

### Fixed

- Show what a team proposal card's added, removed and team-level changes say

## 1.305.0 — 2026-11-19

### New

- Command center cards scale with zoom, stay mounted, load lighter pages

## 1.304.1 — 2026-11-19

### Fixed

- List codex context windows from the run's profile

## 1.304.0 — 2026-11-19

### New

- Keep finished threads on the command center until archived (GEN-316)
- Answer, archive and open threads from the command center timeline (GEN-316)

## 1.303.0 — 2026-11-19

### New

- Open a command center thread as a card in its node's place (GEN-316)
- Drag command center nodes and keep their places (GEN-316)

## 1.302.0 — 2026-11-19

### New

- Count background work as working and restyle the working-threads card (GEN-316)

## 1.301.0 — 2026-11-19

### New

- One thread event card for messages between threads (GEN-316)

## 1.300.1 — 2026-11-19

### Fixed

- Keep the iPad page from staying lifted after the keyboard closes

## 1.300.0 — 2026-11-18

### New

- Command center manager speaks only on done or a question

## 1.299.0 — 2026-11-18

### New

- Open command center threads in windows over the graph

## 1.298.0 — 2026-11-18

### New

- Standing instructions in Settings and archiving threads by asking the manager

### Fixed

- Keep the command center mounted between visits

## 1.297.4 — 2026-11-18

### Fixed

- Carry a thread on in its work's source folder when its worktree is gone

## 1.297.2 — 2026-11-18

### Fixed

- Put a task's collected worktree back when an agent's button is pressed

## 1.297.1 — 2026-11-18

### Fixed

- Let memory_read take a single id

## 1.297.0 — 2026-11-18

### New

- Draw the manager's new thread as a card in its chat

## 1.296.0 — 2026-11-18

### New

- Remove the agree/disagree verdict on an analysis's member marks
- Have an analysis hand sub-agents a narrow brief, never a fork
- Full model settings and a new chat for the command center manager

### Fixed

- Name an unreachable server in retry notices, skip reopen notice when nothing was saved
- Run a board task in its folder when that folder is not a git repository
- Keep command center cards in place while their threads run

## 1.295.1 — 2026-11-18

### Fixed

- Have knowledge_read say how to reach another project's document

## 1.295.0 — 2026-11-18

### New

- Put every change a team analysis proposes on its card

## 1.294.3 — 2026-11-18

### Fixed

- Keep an analysis's tools through the stretch its CLI runs after a turn

## 1.294.2 — 2026-11-18

### Fixed

- Draw no autopilot mark on the project picker's rows

## 1.294.1 — 2026-11-18

### Fixed

- Open memory entries in a window and keep group actions above the rows
- Keep a thinking stretch open while background work reports

## 1.294.0 — 2026-11-18

### New

- Show each model's list price wherever a model is named

## 1.293.4 — 2026-11-18

### Fixed

- End what a finished card's run left running

## 1.293.3 — 2026-11-18

### Fixed

- Decide a thread's lessons in the archive dialog, not on delete

## 1.293.2 — 2026-11-18

### Fixed

- Never lose a transcript row to how a value is written

## 1.293.1 — 2026-11-18

### Fixed

- Send a queued message after a reconnect that missed a compaction's end

## 1.293.0 — 2026-11-18

### New

- Stream every agent's reply and thinking live, team members included

## 1.292.0 — 2026-11-18

### New

- Add the command center (GEN-266)

## 1.291.2 — 2026-11-18

### Improved

- Read a team run's call cards in one statement per read, not per call

## 1.291.1 — 2026-11-17

### Fixed

- Show a message while its task's collected worktree is put back

## 1.291.0 — 2026-11-17

### New

- Make every Settings page explain itself, fold long lists and widen the layout

## 1.290.0 — 2026-11-17

### New

- Never start an MCP server a team member switched off

### Fixed

- Stop a dead daemon's left background commands at the next boot

## 1.289.0 — 2026-11-17

### New

- Reflect on the thread's own model and make lessons visible

## 1.288.2 — 2026-11-17

### Fixed

- Hand the in-app browser back to a window still connected (GEN-307)

## 1.288.1 — 2026-11-17

### Fixed

- Open a clicked picture in the app's viewer

## 1.288.0 — 2026-11-17

### New

- Keep CLI updates busy until they land, mark available ones, sign in to a new configuration

### Fixed

- Read a thread whose sub-agents are still out as running

## 1.287.1 — 2026-11-17

### Fixed

- Stop the hidden Teams screen re-reading team stats on every turn
- Draw no callee block for a call row whose card has not landed yet

## 1.287.0 — 2026-11-17

### New

- Explain every Storage action and keep its figures between visits

## 1.286.0 — 2026-11-17

### New

- Artifact pages play local media, open folders and keep answers

## 1.285.0 — 2026-11-16

### New

- Filter threads by last activity, archived included (GEN-305)

## 1.284.0 — 2026-11-16

### New

- Sort every unsorted cleanup entry with AI, not just the loaded page

## 1.283.2 — 2026-11-16

### Fixed

- Draw a chat image on its own line

## 1.283.1 — 2026-11-16

### Fixed

- Switch codex's own question tools off so questions reach geniro's card

## 1.283.0 — 2026-11-16

### New

- Keep just-used agents warm and set how many stay running
- Offer every team member geniro's question card

### Fixed

- Show the real result of cursor MCP tool calls

## 1.282.1 — 2026-11-16

### Fixed

- Announce the model a refused ACP turn actually runs on

## 1.282.0 — 2026-11-16

### New

- Revise a published artifact with partial edits (GEN-298)

## 1.281.2 — 2026-11-16

### Fixed

- Announce a self-opened turn's ending unless a monitor is still running

## 1.281.1 — 2026-11-16

### Fixed

- Lead the agents tile with whoever works, not an unseen failure

## 1.281.0 — 2026-11-16

### New

- Show and switch a member's MCP servers on a project's page

### Fixed

- Keep a phone's scroll gesture whole while older history pages in
- Name cursor MCP calls by server and tool
- Resend a cursor turn's brief when its saved conversation lost the request
- Fall back from a call's named pool member on a usage limit

## 1.280.2 — 2026-11-16

### Fixed

- Retake plan limits on refresh when no live process can answer

## 1.280.1 — 2026-11-16

### Fixed

- Keep the last good model list when a cursor model probe gets no answer

## 1.280.0 — 2026-11-16

### New

- Let agents' marks clean shared memory and promote lessons (GEN-237)

## 1.279.0 — 2026-11-16

### New

- Save lessons to project instructions, member instructions and knowledge (GEN-237)

## 1.278.0 — 2026-11-16

### New

- Reflect on archive by itself and file lessons into searchable memory (GEN-237)

## 1.277.0 — 2026-11-16

### New

- Reflect on a thread and save its lessons to memory (GEN-237)

## 1.276.0 — 2026-11-16

### New

- Switch and pin the pool slot of a member's own conversation

## 1.275.0 — 2026-11-15

### New

- Show a member's chips in its conversation popup

## 1.274.0 — 2026-11-15

### New

- Sub-agent card shows requests, messages, tokens and cost, and loads its own steps

## 1.273.1 — 2026-11-15

### Fixed

- Open an artifact's linked pictures in the image viewer and let Escape leave its frame

## 1.273.0 — 2026-11-15

### New

- Show which memory every chat loads and sort cold entries with AI

## 1.272.7 — 2026-11-15

### Fixed

- Draw no tail row for a callee whose call card is off the page

## 1.272.6 — 2026-11-15

### Fixed

- Import a claude session without IDE tags

## 1.272.5 — 2026-11-15

### Fixed

- Settle a woken run completed once the members that failed its pass have recovered

## 1.272.4 — 2026-11-13

### Fixed

- Re-stamp call membership per run from covering indexes and read kind rows by their index

## 1.272.3 — 2026-11-13

### Improved

- Read only changed runs in the boot reconcile of stranded work

## 1.272.2 — 2026-11-13

### Fixed

- Ask another agent on the same account for plan limits after eviction

## 1.272.1 — 2026-11-13

### Fixed

- Wake a cursor agent when its background command ends after the turn

## 1.272.0 — 2026-11-13

### New

- Switch memory and disk warnings off from Settings

### Fixed

- Keep a nested callee's live row inside its call card

## 1.271.1 — 2026-11-13

### Fixed

- Show no count on Tasks in the menu

## 1.271.0 — 2026-11-13

### New

- Count what waits on the user in the menu

## 1.270.0 — 2026-11-12

### New

- Let only a team run's lead write its goals

## 1.269.0 — 2026-11-12

### New

- Draw a callee's own calls inside its call card

## 1.268.0 — 2026-11-12

### New

- Agents and the user name and colour in-app browser tabs

## 1.267.0 — 2026-11-12

### New

- Open the in-app browser in a window of its own with all its tabs

## 1.266.0 — 2026-11-12

### New

- Open chat links in the in-app browser only while it is open, and choose on right-click

## 1.265.0 — 2026-11-12

### New

- Move the browser globe to the agents panel, close tabs from the strip, expand the browser

## 1.264.0 — 2026-11-12

### New

- Let a team run's lead save project instructions and propose teams

## 1.263.1 — 2026-11-12

### Fixed

- Stop the memory-growth warning firing on one-off memory steps

## 1.263.0 — 2026-11-12

### New

- Fold in-app browser tool rows into the tool group

## 1.262.0 — 2026-11-12

### New

- Add an in-app browser beside each chat, driven by the user and by agents

## 1.261.0 — 2026-11-11

### New

- Warn about a thread eating memory, low system memory and a full disk

## 1.260.0 — 2026-11-11

### New

- Show messages waiting from other threads above the composer, with Deliver now

## 1.259.0 — 2026-11-11

### New

- Clean up the shared memory from Settings with batch forget and undo (GEN-241)
- Check shared memory for duplicates and contradictions, and merge (GEN-241)
- Delete forgotten memories for good and auto-forget cold ones (GEN-241)

## 1.258.0 — 2026-11-11

### New

- Count how agents use each shared-memory entry (GEN-241)

## 1.257.1 — 2026-11-11

### Fixed

- Stop the chat tail only when the reader scrolls up, not the layout

## 1.257.0 — 2026-11-11

### New

- Show each run's own terminals, monitors, sub-agents and tasks in the agents panel

## 1.256.10 — 2026-11-11

### Fixed

- Keep a team run running while its calls work, and mark the Manager's reply

## 1.256.9 — 2026-11-11

### Fixed

- Drop the run-without-asking strip from the team proposal card

## 1.256.8 — 2026-11-11

### Fixed

- Keep a call handed to the next pool member running, not waiting

## 1.256.7 — 2026-11-11

### Fixed

- Anchor a call's card rows to a page of its own conversation

## 1.256.6 — 2026-11-10

### Fixed

- Badge a team run whose leads only wait on their calls as held

## 1.256.5 — 2026-11-10

### Fixed

- Refill the ACP resume budget after a resumed turn makes progress

## 1.256.4 — 2026-11-10

### Fixed

- Announce a team run as running when it starts

## 1.256.3 — 2026-11-10

### Fixed

- Draw each current run as its own card in the agents panel

## 1.256.2 — 2026-11-10

### Fixed

- Keep tool calls grouped across monitor starts

## 1.256.1 — 2026-11-10

### Fixed

- Open an agent's conversation from the agents panel, pinned by a press

## 1.256.0 — 2026-11-10

### New

- Message an agent and read its call figures from its popup

## 1.255.1 — 2026-11-09

### Fixed

- Show that a chat is compacting and why a queued Send was refused

## 1.255.0 — 2026-11-09

### New

- Judge a team from all its runs and let a refused card be patched

## 1.254.0 — 2026-11-09

### New

- Fold storage rows and delete archived chats by period

## 1.253.0 — 2026-11-09

### New

- Let an analysis read a team's spend and page its history by section

## 1.252.0 — 2026-11-09

### New

- Show each working agent's latest messages on a redesigned agents card

## 1.251.1 — 2026-11-09

### Fixed

- Let an agent reopen a closed goal

## 1.251.0 — 2026-11-09

### New

- Offer Codex's Fast mode wherever a model's settings are chosen

## 1.250.0 — 2026-11-09

### New

- Reach any project's or team's knowledge from team, project and analysis chats
- Show hover on the agents card's rows and controls
- Let analyses recommend moving text to and from knowledge

## 1.249.0 — 2026-11-09

### New

- Change any team or project from team, project and analysis chats

## 1.248.0 — 2026-11-09

### New

- Let agents message other threads

## 1.247.0 — 2026-11-09

### New

- Show a team run's agents in a card beside the chat

## 1.246.0 — 2026-11-08

### New

- Change a project's team overlay from any chat

## 1.245.0 — 2026-11-08

### New

- Remember the last setup in analysis, team and project chats

## 1.244.1 — 2026-11-08

### Fixed

- Open the chat file picker from a direct press on the phone

## 1.244.0 — 2026-11-08

### New

- A document store agents find and read on demand

## 1.243.5 — 2026-11-08

### Fixed

- Show when a cursor turn is waiting on a background command
- Keep a chat's host tools for what the CLI does between turns
- Show the artifact share panel beside its button
- Close a menu on a press inside an artifact's frame

## 1.243.4 — 2026-11-08

### Fixed

- Show a public address only once it answers

## 1.243.3 — 2026-11-08

### Fixed

- Stop monitors hanging a call and running twice

## 1.243.2 — 2026-11-08

### Fixed

- Wait out a usage limit instead of tripping the autopilot breaker

## 1.243.1 — 2026-11-08

### Fixed

- Keep the update offer when a scheduled check fails

## 1.243.0 — 2026-11-08

### New

- Change a library team and a project's instructions from any chat

## 1.242.6 — 2026-11-07

### Fixed

- Rebuild and publish a stranded draft release by hand

## 1.242.5 — 2026-11-06

### Fixed

- Keep a call card's live line on the callee's own state

## 1.242.4 — 2026-11-06

### Fixed

- Count a stacked pull request's changes from its own base

## 1.242.3 — 2026-11-06

### Fixed

- Ask before Send cancels sub-agents and hold the queue for cards

## 1.242.1 — 2026-11-06

### Fixed

- Show a cursor member's cost on its call cards
- Keep claude's plan limit from dropping on refresh

## 1.242.0 — 2026-11-06

### New

- Add a project's own team blocks for picked members

## 1.241.2 — 2026-11-06

### Fixed

- Open a picture from an artifact page's click-to-enlarge

## 1.241.1 — 2026-11-05

### Fixed

- Put back the task worktree an analysis chat works in

## 1.241.0 — 2026-11-05

### New

- Let a stand lower the spend-poll floor with GENIRO_SPEND_POLL_FLOOR_MS

## 1.240.0 — 2026-11-05

### New

- Builder chat reads teams in parts and moves rules into a project on one card

## 1.239.2 — 2026-11-05

### Fixed

- Price cursor conversations on their own config profile's account

## 1.239.1 — 2026-11-05

### Fixed

- Draw only the changed lines of an edit's diff, bounded

## 1.239.0 — 2026-11-04

### New

- A project's chat reads its own team with read_teams

## 1.238.1 — 2026-11-04

### Fixed

- Count the running turn in the context readout's thread cost

## 1.238.0 — 2026-11-04

### New

- Leaner member and project team screens, Edit JSON for MCP

## 1.237.0 — 2026-11-04

### New

- A project's own chat for its instructions and team overrides; no stage addenda

## 1.236.0 — 2026-11-04

### New

- Calmer team and project screens: short texts, live overrides, folded lists

## 1.235.0 — 2026-11-04

### New

- Open "Where the run went" as a sequence diagram of the run's calls

### Fixed

- Read claude's dated limit resets, so a spent pool member stays skipped
- Say a call card is waiting on its monitor, not that the callee is thinking

## 1.234.2 — 2026-11-04

### Fixed

- Keep short table cells and badge rows tidy on artifact pages

## 1.234.1 — 2026-11-04

### Fixed

- Fold back-to-back reasoning summaries into one Thought line

## 1.234.0 — 2026-11-04

### New

- One Progress popup for a thread's goals, outcome and stages

## 1.233.1 — 2026-11-04

### Fixed

- Keep the goals tool loaded so agents read when to set goals

## 1.233.0 — 2026-11-04

### New

- Keep the Mac awake while agents work, with a switch in Settings

## 1.232.3 — 2026-11-04

### Fixed

- Keep a hover-opened panel while the pointer travels to it

## 1.232.2 — 2026-11-04

### Fixed

- Open the member sheet's menus in place and tidy the shelf popovers

## 1.232.1 — 2026-11-04

### Fixed

- State every pull request's figures and count each change once

## 1.232.0 — 2026-11-03

### New

- One team, many projects — per-project overlays of the project's default team

## 1.231.0 — 2026-11-03

### New

- Judge each member's work, measure changes to it and let the user correct the marks

## 1.230.0 — 2026-11-03

### New

- Draw the team header's figures with icons and say long work time in days

## 1.229.0 — 2026-11-03

### New

- Pick a block's audience from a chip and a popover
- Tidy the project page's board, instruction size and run configuration cards

### Fixed

- Let a pinned question shrink to a dock shorter than its cap

## 1.228.1 — 2026-11-03

### Fixed

- Time a call card by how long the call is open, its own waits included

## 1.228.0 — 2026-11-03

### New

- The team dock and analysis popups are the chat screen itself

## 1.227.1 — 2026-11-03

### Fixed

- Read claude's init pending MCP status as connecting, not awaiting approval

## 1.227.0 — 2026-11-03

### New

- Instruction blocks, full run setup and team stats polish

## 1.226.0 — 2026-11-02

### New

- Ask in a confirm dialog everywhere, never a second press

## 1.225.0 — 2026-11-02

### New

- Run configurations in their projects, instruction sizes, team page polish

## 1.224.0 — 2026-11-02

### New

- Bind runs to projects, a Projects page and P- recommendations

## 1.223.0 — 2026-11-02

### New

- Goals tool and measurable threads

## 1.222.0 — 2026-11-02

### New

- Team memory, per-team statistics and member setup warnings

## 1.221.0 — 2026-11-02

### New

- Teams instead of workflow graphs

## 1.220.1 — 2026-11-02

### Fixed

- Declutter the composer shelf — one chip per kind

## 1.220.0 — 2026-11-02

### New

- Relay mode — the stage lead owns the stage and hands the run on with a brief

## 1.219.1 — 2026-11-01

### Fixed

- Keep a card's worktree while its run works outside a turn

## 1.219.0 — 2026-11-01

### New

- Members, trigger, blocks and stages in one-lead mode, with a list editor

## 1.218.0 — 2026-11-01

### New

- Rename Workflow to Team across daemon, renderer, storage and docs

## 1.217.1 — 2026-11-01

### Fixed

- Mark a call card waiting while its callee waits on a monitor, and scroll the phone shelf

## 1.217.0 — 2026-11-01

### New

- Journaled migrations, settings migrator and project instructions

## 1.216.1 — 2026-11-01

### Fixed

- Compact composer shelf chips, one-press monitor stop, root-only sub-agents

## 1.216.0 — 2026-10-31

### New

- Show what Geniro keeps on disk and clean it up

## 1.215.0 — 2026-10-31

### New

- Animated status glyphs for the composer shelf's counters

## 1.214.1 — 2026-10-31

### Improved

- Load less and re-render less for a phone on a long thread

## 1.214.0 — 2026-10-31

### New

- Show how long each called agent has worked, and give analyses the figure

## 1.213.1 — 2026-10-31

### Fixed

- Let a quiet monitor wait up to a day instead of waking hourly

## 1.213.0 — 2026-10-30

### New

- Draw the stage graph with React Flow and route its wires with ELK

## 1.212.1 — 2026-10-30

### Fixed

- Count, announce and time the work a CLI does on its own between turns

## 1.212.0 — 2026-10-30

### New

- Explain where a workflow's time and money go on its analysis card

## 1.211.0 — 2026-10-30

### New

- Show each pull request's outcome history and fix record_outcome question counts

## 1.210.1 — 2026-10-30

### Fixed

- One text size and one-line rows on the phone composer

## 1.210.0 — 2026-10-30

### New

- Give workflow analysis its versions, change log and earlier recommendations

## 1.209.0 — 2026-10-29

### New

- Show the memory entries a memory tool call used in a popover

## 1.208.4 — 2026-10-29

### Fixed

- Mark the open thread with a bar and keep its colour

## 1.208.3 — 2026-10-29

### Fixed

- Count text handed to a tool the user reads as a reply in the reply language
- Move a continued call back to pool member 1 once its limit resets
- Draw a codex reasoning summary of titles alone as status lines

## 1.208.2 — 2026-10-29

### Fixed

- Show a pool hand-off where it happened in the call card

## 1.208.1 — 2026-10-29

### Fixed

- Stop a user's codex PermissionRequest hook from holding every approval

## 1.208.0 — 2026-10-29

### New

- Choose the whole model configuration for the memory import's AI sort

## 1.207.0 — 2026-10-29

### New

- Read cursor plan limits from the account

## 1.206.1 — 2026-10-29

### Fixed

- Tell a workflow caller when a cursor callee's service refused the request

## 1.206.0 — 2026-10-29

### New

- Compact status counters on the right of the composer shelf

## 1.205.1 — 2026-10-29

### Fixed

- Offer a profile named in Settings to the builder and the board without a restart

## 1.205.0 — 2026-10-29

### New

- Sort the memory import with AI, group notes by where they came from, page the list

### Fixed

- A readable workflow proposal card with a zoomable graph
- Draw a thread waiting on its monitor with a timer, not a radar

## 1.204.0 — 2026-10-29

### New

- Give the workflow builder chat the workflow analysis's tools and method

## 1.203.1 — 2026-10-29

### Fixed

- Stop the renderer chaining every past render into memory

## 1.203.0 — 2026-10-29

### New

- Manage the shared memory from Settings and import each CLI's own notes

## 1.202.0 — 2026-10-28

### New

- Snapshot a shared-memory index into every new run's instructions

## 1.201.1 — 2026-10-28

### Fixed

- One-line call status that names only a tool still running

## 1.201.0 — 2026-10-28

### New

- Report time per run and agent, instruction size and quality in a workflow analysis
- Tell every agent when each of geniro's own tools is the move
- Show a thread waiting on its monitor as waiting, not completed

## 1.200.0 — 2026-10-28

### New

- Share one memory across every agent CLI through geniro's MCP tools

## 1.199.0 — 2026-10-28

### New

- Edit a workflow's stages from the builder chat and draw them on the canvas

## 1.198.1 — 2026-10-28

### Fixed

- Resume a cursor prompt whose connection drop arrives as an error reply

## 1.198.0 — 2026-10-28

### New

- One notes popup for your notes and the team notes, opened from the panel, the chip and the chat

## 1.197.0 — 2026-10-28

### New

- Named configurations for cursor-agent

## 1.196.2 — 2026-10-28

### Fixed

- Reopen a codex thread without its history and fail a reply too long to read

## 1.196.1 — 2026-10-28

### Fixed

- Stop whole-run reads from blocking the event loop

## 1.196.0 — 2026-10-27

### New

- Analyze a workflow across its latest runs and suggest model and graph changes

## 1.195.1 — 2026-10-27

### Fixed

- Stop showing team notes' numeric ids

## 1.195.0 — 2026-10-27

### New

- Give a workflow a stage graph every run walks

## 1.194.0 — 2026-10-27

### New

- Show_gallery takes image URLs, per-picture descriptions and a scrolling strip

## 1.193.0 — 2026-10-27

### New

- Show the run's running monitors as a shelf chip

## 1.192.1 — 2026-10-27

### Fixed

- Offer named profiles in the New task dialog and create the card on the one picked

## 1.192.0 — 2026-10-27

### New

- Put every builder chat change on a propose_workflow card first

### Fixed

- Let the workflow chat dock's reader scroll up while the agent streams

## 1.191.0 — 2026-10-27

### New

- Make the record_outcome row readable and expandable

## 1.190.0 — 2026-10-27

### New

- Version every workflow run, show each version's runs, cost and diff, and restore one

## 1.189.0 — 2026-10-27

### New

- Team notes in the Notes popup, whole-card note presses, themed tooltips

## 1.188.0 — 2026-10-27

### New

- Record each pull request's outcome with record_outcome

## 1.187.1 — 2026-10-26

### Fixed

- Let the workflow builder chat change its workflow through save_workflow_change

## 1.187.0 — 2026-10-26

### New

- Start a thread analysis on auto-approve and let the dialog pick its mode

## 1.186.0 — 2026-10-26

### New

- Cap active agent turns per run at every call depth

## 1.185.3 — 2026-10-26

### Fixed

- Stop the composer shelf squeezing pull requests to an empty card

## 1.185.1 — 2026-10-26

### Fixed

- Record refused ACP calls as errors and end codex late work

## 1.185.0 — 2026-10-26

### New

- Redesign the agents panel — readouts in popups, clearer controls and rows

## 1.184.0 — 2026-10-26

### New

- Show each agent node's always-on instruction size in the inspector

## 1.183.0 — 2026-10-26

### New

- Tag each analysis recommendation as process or domain

## 1.182.0 — 2026-10-26

### New

- Add a reply-language setting every agent is told to answer in

## 1.181.0 — 2026-10-26

### New

- Team notes — a run-wide note store every agent of a workflow can write and read

## 1.180.4 — 2026-10-26

### Fixed

- Count call and sub-agent figures on the daemon over every row

## 1.180.3 — 2026-10-25

### Fixed

- Show a loading row while a newly picked model's settings are read

## 1.180.2 — 2026-10-22

### Fixed

- Keep a CLI-recorded pull request only when the thread names it

## 1.180.1 — 2026-10-22

### Fixed

- Save workflow changes as edits, and show a long tool call being written

## 1.180.0 — 2026-10-22

### New

- Detect an expired cloud login, sign in with one click, retry the share

## 1.179.1 — 2026-10-22

### Fixed

- Let a re-listing correct a thread's "waiting on you" badge

## 1.179.0 — 2026-10-22

### New

- Revoke all shared pages, auto-revoke old ones, show when each was shared

## 1.178.0 — 2026-10-21

### New

- Monitor tool — run a command and wake the agent with its output

## 1.177.1 — 2026-10-21

### Fixed

- Give artifact pages themed element defaults and design guards

## 1.177.0 — 2026-10-21

### New

- Rank threads by what is waiting on me, with a jump-to-next shortcut

## 1.176.1 — 2026-10-21

### Fixed

- Return a pooled node to member 1 once its usage limit resets

## 1.176.0 — 2026-10-21

### New

- Offer the agent's real permission options (this session / always), not just yes/no

## 1.175.1 — 2026-10-21

### Fixed

- Leave the hosted chat's queue standing after a Stop

## 1.175.0 — 2026-10-21

### New

- Render ACP `plan` session updates in the transcript

## 1.174.1 — 2026-10-21

### Fixed

- Queue a message typed mid-reply, whatever background work is out

## 1.174.0 — 2026-10-21

### New

- Draw an agent's workflow proposal on its own approval card

## 1.173.3 — 2026-10-21

### Fixed

- Guard whole-file patch cards against stale files

## 1.173.2 — 2026-10-21

### Improved

- Skip unchanged cursor config parameters

## 1.173.1 — 2026-10-21

### Fixed

- Continue pooled agent calls after usage limits

## 1.173.0 — 2026-10-21

### New

- Let agents publish buttons that run a command after the user confirms it

## 1.172.0 — 2026-10-21

### New

- Stop what a run's agents left outside the CLI once it sits unused

## 1.171.0 — 2026-10-20

### New

- Let a chat agent propose a workflow on an approval card

## 1.170.1 — 2026-10-20

### Fixed

- Stop what an agent CLI left running when it dies

## 1.170.0 — 2026-10-20

### New

- Let agents publish buttons that stop a process they started

## 1.169.0 — 2026-10-20

### New

- Make the kept-session idle window a setting (default 1 h) and close idle sessions gracefully

## 1.168.2 — 2026-10-20

### Fixed

- Defer plan and patch cards when the CLI will not hold the call

## 1.168.1 — 2026-10-20

### Fixed

- Hold a cursor turn's prompt until its last config frame is answered

## 1.168.0 — 2026-10-20

### New

- Let workflow agents publish buttons the manager receives

## 1.167.0 — 2026-10-20

### New

- Let agents publish message buttons the user can press

## 1.166.3 — 2026-10-20

### Fixed

- Mark a follow-up a turn dropped as not sent, with Resend

## 1.166.2 — 2026-10-20

### Fixed

- Stop a finished chat showing running after its turn ended

## 1.166.1 — 2026-10-19

### Fixed

- Make plan-limits refresh retake the reading and stop the context popover jumping

## 1.166.0 — 2026-10-19

### New

- Show untracked subagents and recover missed endings

## 1.165.1 — 2026-10-19

### Fixed

- Make a codex Stop end its running command, keep its late updates out of the next turn, and stop passing agents ELECTRON_RUN_AS_NODE

## 1.165.0 — 2026-10-19

### New

- Mark cost and context values geniro computed itself as estimates

## 1.164.2 — 2026-10-19

### Fixed

- Report a public tunnel address as expired once its tunnel is gone

## 1.164.1 — 2026-10-19

### Fixed

- Stop the archived-chat request storm and page the archive

## 1.164.0 — 2026-10-19

### New

- Add delivery receipts for agent messages

## 1.163.0 — 2026-10-19

### New

- Load more tasks in board columns

## 1.162.1 — 2026-10-18

### Fixed

- Stop undici's setTypeOfService EINVAL from crashing main

## 1.162.0 — 2026-10-18

### New

- Copy .worktreeinclude files into new task worktrees

## 1.161.1 — 2026-10-18

### Fixed

- Start in ~1.5 s and show a real startup screen instead of a failure banner

## 1.161.0 — 2026-10-18

### New

- Make the run waterfall an interactive analysis view

## 1.160.0 — 2026-10-16

### New

- Tell agents how background sub-agents and commands behave

## 1.159.1 — 2026-10-16

### Fixed

- Tidy the onboarding start screen

## 1.159.0 — 2026-10-16

### New

- Show resolved models and context window details

## 1.158.0 — 2026-10-16

### New

- Split a node's own tool calls and cost from its sub-agents'

## 1.157.0 — 2026-10-16

### New

- Name background commands still running in a callee's answer

## 1.156.1 — 2026-10-16

### Fixed

- Apply a node's autoCompactPercent from its first turn

## 1.156.0 — 2026-10-16

### New

- Show each thread's context size in list_agent_threads

## 1.155.1 — 2026-10-16

### Fixed

- Stop double-billing a resumed claude session's cost

## 1.155.0 — 2026-10-16

### New

- Stop detached processes from the thread process panel

## 1.154.5 — 2026-10-16

### Fixed

- Keep a stale session's process while its background commands run

## 1.154.4 — 2026-10-16

### Fixed

- Don't count the time a Mac sleeps as an agent's silence
- Release a group's projects when the group is deleted
- Carry a claude conversation back to a profile with the turns made on the other one
- Continue a workflow card's run on Run and Follow up

## 1.154.3 — 2026-10-16

### Fixed

- Hold a card whose worktree can't be prepared instead of starving the queue

## 1.154.2 — 2026-10-16

### Fixed

- Preview an image-only message as an image label

## 1.154.1 — 2026-10-16

### Fixed

- Make the dirty-switch strip reach the picked branch, and list main branches first

## 1.154.0 — 2026-10-16

### New

- Analyse a thread's environment as well as its time, with retro's method

## 1.153.3 — 2026-10-16

### Fixed

- Re-send a cursor turn's brief when its request died before any step

## 1.153.2 — 2026-10-16

### Fixed

- Label the place form and take the key out of a shared page's address

## 1.153.1 — 2026-10-16

### Fixed

- Run a card whose branch a deleted worktree still holds, and show git's real error

## 1.153.0 — 2026-10-15

### New

- Share artifacts as end-to-end-encrypted links

## 1.152.3 — 2026-10-15

### Fixed

- Count what a thread's agents changed in worktrees they made

## 1.152.2 — 2026-10-15

### Fixed

- Say when a workflow call leaves a command running after it finishes

## 1.152.1 — 2026-10-15

### Fixed

- Centre artifact pages and make a saved file look like the framed one

## 1.152.0 — 2026-10-15

### New

- Analyze a thread and apply its recommendations

## 1.151.2 — 2026-10-14

### Fixed

- Show the card loader while a workflow agent writes an artifact

## 1.151.1 — 2026-10-14

### Fixed

- Keep a sub-agent working while a command it detached still runs

## 1.151.0 — 2026-10-14

### New

- Offer Copy Link when right-clicking a link

## 1.150.1 — 2026-10-14

### Fixed

- File a working callee's in-turn notes inside the call it answers

## 1.150.0 — 2026-10-14

### New

- Load a workflow run's transcript one conversation at a time

## 1.149.0 — 2026-10-14

### New

- Show pages a workflow callee publishes in the run's chat

## 1.148.8 — 2026-10-14

### Fixed

- Show the pull requests a thread opened or touched as chips

## 1.148.7 — 2026-10-14

### Fixed

- Stop the workflow clock while a question waits with nothing running

## 1.148.6 — 2026-10-13

### Fixed

- Stop and show what a thread's agents left running

## 1.148.5 — 2026-10-13

### Fixed

- Stop rebuilding model-settings rows on every streamed delta

## 1.148.3 — 2026-10-12

### Fixed

- List named profiles in the model panel's Profile axis

## 1.148.2 — 2026-10-13

### Fixed

- Tell a working caller its call finished, and say so when it steers one

## 1.148.0 — 2026-10-12

### New

- Record why the daemon stopped and hold crash-cut cards from the autopilot

## 1.147.8 — 2026-10-12

### Fixed

- Stop a foreground command from the terminals list

## 1.147.7 — 2026-10-12

### Fixed

- Pass long instructions through private prompt files
- Deduplicate retried messages by client id
- Report model mismatches once per turn

## 1.147.6 — 2026-10-12

### Fixed

- Polish onboarding and preserve local engine continuity

## 1.147.5 — 2026-10-12

### Fixed

- Settle server sign-ins on a real connect and retire only the sessions a change reaches

## 1.147.4 — 2026-10-12

### Fixed

- Make a claude.ai connector usable as soon as it connects

## 1.147.3 — 2026-10-12

### Fixed

- Keep artifact dialog controls clickable above title bar

## 1.147.2 — 2026-10-12

### Fixed

- Stop the context readout scrolling sideways

## 1.147.1 — 2026-10-12

### Fixed

- Make ask and plan turns ask whatever the user's own config says

## 1.147.0 — 2026-10-12

### New

- Let callers see each callee's prompt cache before resuming it

## 1.146.0 — 2026-10-12

### New

- Search every chat with SQLite full-text search

## 1.145.0 — 2026-10-11

### New

- Say why a prompt cache is short, and make the warning closable

## 1.144.5 — 2026-10-11

### Fixed

- Open artifact links without a confirmation bar

## 1.144.4 — 2026-10-11

### Fixed

- Let phone browsers frame artifact pages

## 1.144.3 — 2026-10-11

### Fixed

- Hold a call until the calls its callee made have finished

## 1.144.2 — 2026-10-11

### Fixed

- Stop chat continuations and prevent stale session updates

## 1.144.1 — 2026-10-11

### Fixed

- Enable agent pools for root agents

## 1.144.0 — 2026-10-10

### New

- Improve shared design guidance

## 1.143.2 — 2026-10-10

### Fixed

- Select agent pools in priority order

## 1.143.1 — 2026-10-10

### Fixed

- Expand artifacts to fill the window

## 1.143.0 — 2026-10-09

### New

- Distinguish agent messages and stop requests

## 1.142.0 — 2026-10-09

### New

- Add four-step guided onboarding

## 1.141.0 — 2026-10-09

### New

- Draw the builder chat with the thread's own ring and status
- Queue messages in the builder chat, through the chat screen's queue

## 1.140.0 — 2026-10-09

### New

- Warn in the composer when the prompt cache has lapsed

## 1.139.0 — 2026-10-09

### New

- Install missing agent CLIs from their cards

## 1.138.0 — 2026-10-09

### New

- Show local pictures by path and open page links on the reader's press

## 1.137.0 — 2026-10-09

### New

- Show threads, pull requests, lines and time per thread

### Improved

- Read a folder's head in one git process, and its repository once

### Fixed

- Count lines per repository, bound the measurement, and fix the review findings

## 1.136.1 — 2026-10-09

### Fixed

- Page older history again after reopening a thread
- Keep a running turn's spend across reopen and restart

## 1.136.0 — 2026-10-09

### New

- Refresh plan limits by hand and when stale

## 1.135.0 — 2026-10-09

### New

- Brief the workflow builder agent from the real schema

## 1.134.0 — 2026-10-09

### New

- Support offline Ollama models [GEN-75]

## 1.133.3 — 2026-10-08

### Fixed

- Preserve codex threads across account switches

## 1.133.2 — 2026-10-08

### Fixed

- Support workflow chat attachments and center status rows

## 1.133.1 — 2026-10-08

### Fixed

- Respawn a kept CLI process whose working directory was replaced

## 1.133.0 — 2026-10-08

### New

- Pool-aware MCP and CLI labels, codex MCP/context/spend, add-MCP dialog

## 1.132.0 — 2026-10-07

### New

- Full settings per agent-pool member, pools on agent cards, codex context window

## 1.131.2 — 2026-10-07

### Fixed

- Say why a CLI update failed on the agent card

## 1.131.1 — 2026-10-07

### Fixed

- End an off-turn stretch a later pass continues, and count turns per conversation

## 1.131.0 — 2026-10-07

### New

- Agent pool for workflow nodes
- One Agent palette tile; a node's CLI is a setting

## 1.130.1 — 2026-10-07

### Fixed

- Share plan limits per account and show a loader while they load

## 1.130.0 — 2026-10-07

### New

- Show codex's own recorded update check on its agent card

## 1.129.0 — 2026-10-06

### New

- List cursor plugin servers and copy one into ~/.cursor/mcp.json

## 1.128.1 — 2026-10-06

### Fixed

- Keep a held turn segment's cost on the live plane

## 1.128.0 — 2026-10-06

### New

- Attach files and images from a composer button, on the phone too

## 1.127.0 — 2026-10-06

### New

- Sync unread marks and sidebar groups across devices

## 1.126.8 — 2026-10-06

### Fixed

- Phone focus zoom, row actions and pairing code on a paired device

## 1.126.7 — 2026-10-06

### Fixed

- Hold a live row's plain word for a whole cycle

## 1.126.6 — 2026-10-06

### Fixed

- Reconcile every agent's spend with what its vendor billed

## 1.126.5 — 2026-10-05

### Fixed

- Price cursor spend correctly and make the breakdowns readable

## 1.126.4 — 2026-10-05

### Fixed

- Announce captured pull requests from the listing pass too

## 1.126.3 — 2026-10-05

### Fixed

- Keep the saved-configurations menu open once the pointer reaches it
- Show the loader, not a lone working row, while a thread's history loads
- Read claude's plan limits from a seeded reply, and wait out its hooks

## 1.126.2 — 2026-10-05

### Fixed

- Keep cut-off cursor sub-agents and run them as ACP sub-agent sessions

## 1.126.0 — 2026-10-05

### New

- Load chart, diagram and UI libraries in artifact pages [GEN-57]

## 1.125.0 — 2026-10-05

### New

- Page the transcript without breaking its readouts

### Fixed

- Catch up a jump that lands on the tail; drive spec batches with fake timers

## 1.124.0 — 2026-10-05

### New

- Rework the phone layout into pages under a bottom tab bar
- Give the phone's chat pages a back button

### Fixed

- Keep the phone tab bar on every page and drop the header back buttons

## 1.123.0 — 2026-10-05

### New

- Change a thread's colour from the sidebar

## 1.122.0 — 2026-10-04

### New

- Board tools any agent can use to read and file cards

## 1.121.0 — 2026-10-04

### New

- Per-thread notes in the right panel, marked in the thread list
- Edit thread notes in the expanded editor popup

## 1.120.0 — 2026-10-04

### New

- Show every process a thread runs, with its CPU and memory
- App-wide usage readout in the title bar; tighten the Processes section
- Show how usage divides by thread; group a thread's processes by role

## 1.119.1 — 2026-10-04

### Fixed

- Draw one turn ending when claude answers inside a continuation
- End a claude turn on the continuation that absorbed its prompt

## 1.119.0 — 2026-10-04

### New

- Add a jump-to-end control to an open agent block's header

### Fixed

- Use a double chevron for the block jump-to-end control
- Word the block jump-to-end control as "Jump to end"

## 1.118.2 — 2026-10-04

### Fixed

- Push every thread's sidebar preview from the one persist seam

## 1.118.1 — 2026-10-04

### Fixed

- Draw a workflow run's own error bare instead of in an empty agent block
- Draw an agent block holding only an error as the error row alone

## 1.118.0 — 2026-10-04

### New

- Reorder run configurations by drag and drop

## 1.117.0 — 2026-10-02

### New

- Delete the CLI's own transcripts when an archived chat is deleted

### Fixed

- Ask claude's plan limits without the seven-day transcript scan

## 1.116.9 — 2026-10-02

### Fixed

- Adopt the login-shell PATH in main so node-script CLIs are detected

## 1.116.8 — 2026-10-01

### Fixed

- Hold a cursor turn for its background sub-agents and wake it when they end

## 1.116.7 — 2026-10-01

### Fixed

- Drop the per-run call cap and size agent parallelism from RAM

## 1.116.6 — 2026-09-30

### Fixed

- Stop a running ACP prompt before sending a mid-turn message

## 1.116.5 — 2026-09-30

### Fixed

- Hand a caller a finished call's result over an unread user message

## 1.116.4 — 2026-09-30

### Fixed

- Draw a queued call as its card, not a bare brief in the caller's flow

## 1.116.3 — 2026-09-30

### Fixed

- Name an ACP tool call by what its later updates disclose
- Keep a pinned thread in place when it starts waiting on the user

## 1.116.1 — 2026-09-30

### Fixed

- End a background sub-agent when it ends, not when its turn does

## 1.116.0 — 2026-09-29

### New

- Add codex as a CLI agent, with every agent fact in its adapter

### Fixed

- Resolve the review of the codex integration
- Resolve the review of the origin/main merge

## 1.115.4 — 2026-09-29

### Fixed

- Phone, sign-in and MCP bugs from the bug-bash ticket
- A turn that ends while the socket is down no longer stays "running"
- Second audit pass — races, stuck states, phone gateway and task board
- Third audit pass — security, stuck turns, data loss and display races
- Fourth audit pass — calls, builder, sign-in, board and stale phone pages
- Usage-limit continue, cursor resume pacing, live and failed-turn cost, review-round bugs
- Third review findings — settles, crash respawn, cursor approvals, withdrawn cards

## 1.115.3 — 2026-09-27

### Fixed

- Share one line between the queue and the composer shelf

## 1.115.2 — 2026-09-27

### Fixed

- Draw turns and calls still running on the run timeline, drop the tool-density strip

## 1.115.1 — 2026-09-24

### Fixed

- Tell every client when a thread is archived, renamed or pinned

## 1.115.0 — 2026-09-24

### New

- Swipe gestures for the phone drawers, and fix two mobile layout bugs

## 1.114.0 — 2026-09-24

### New

- Remove the length cap on custom and workflow instructions

### Fixed

- Send ACP instructions once per session, not with every message

## 1.113.3 — 2026-09-24

### Fixed

- Read a thread on from a timeline jump, and date the archive by real activity

## 1.113.2 — 2026-09-24

### Fixed

- Send cursor config frames one at a time
- Open a thread even when its room join goes unanswered

## 1.113.1 — 2026-09-24

### Fixed

- Keep a question's described options on one line
- Centre a shorter option in its stretched box
- Draw question options without a frame each
- Stack a question's unframed options one per line
- Mark a picked option with its dot alone

## 1.113.0 — 2026-09-24

### New

- Let the agent's question card collapse

## 1.112.6 — 2026-09-24

### Fixed

- Open the composer shelf chips on a click, and make an agent row reveal its card

## 1.112.5 — 2026-09-24

### Fixed

- Show a question's option descriptions and previews, and send context into the question

## 1.112.4 — 2026-09-24

### Fixed

- End a held off-turn stretch at the next turn, and draw it inside its call

## 1.112.3 — 2026-09-24

### Fixed

- Queue a message while the agent waits on a sync sub-agent

## 1.112.2 — 2026-09-23

### Fixed

- Reach the daemon over https on a tunnel's default port

## 1.112.1 — 2026-09-23

### Fixed

- Stop chat jumps, drain the workflow queue, and time agent calls

## 1.112.0 — 2026-09-23

### New

- Steer running calls, wake callers at a usage reset, and attribute the export

## 1.111.0 — 2026-09-22

### New

- Hold the auto-compact threshold inside the turn

## 1.110.4 — 2026-09-22

### Fixed

- State a call card's cost over its whole conversation
- Sign in to an MCP server under the node's own profile

## 1.110.3 — 2026-09-22

### Fixed

- Wake a workflow run with the agents that outlive it

## 1.110.2 — 2026-09-22

### Fixed

- Let a question card outlive the turn that asked it
- Only record an automatic compaction that actually happened
- Keep one run's rows out of another run's transcript

## 1.110.1 — 2026-09-22

### Fixed

- Read cursor's effort axis by more than its name

## 1.110.0 — 2026-09-22

### New

- Open a public address for the gateway with a tunnel client

## 1.109.0 — 2026-09-22

### New

- The run under a magnifying glass — money, order and timing in one card
- The run under a magnifying glass opens full-screen
- A real hover layer on the waterfall

### Fixed

- The waterfall's tool table, and a turn nobody could see

## 1.108.0 — 2026-09-22

### New

- Loader for a card being written, and livelier live rows

## 1.107.1 — 2026-09-22

### Fixed

- Artifact controls on the frame, and no phone button in the header

## 1.107.0 — 2026-09-21

### New

- Open geniro's own interface to a phone on the same Wi-Fi

### Fixed

- Keep the title bar out of the drawer's scrim and name the chat-list button
- Centre the phone drawer openers in the title bar band
- Draw the phone drawer openers as bare icons, centred on the band's ink
- One-line chat header on a phone, and a way into the run panel there

## 1.106.0 — 2026-09-21

### New

- Let an agent publish an interactive page as an artifact
- Save a published artifact as one shareable HTML file

## 1.105.2 — 2026-09-20

### Fixed

- Resume the cursor failures its ACP server never retries
- Name the thread that continues a crashed callee
- Resume the keepalive-ping timeout too, found by reproducing it

## 1.105.1 — 2026-09-19

### Fixed

- Let a user message reach a caller blocked in await_agent

## 1.105.0 — 2026-09-19

### New

- Cancel_agent — let a caller stop a call it no longer wants

## 1.104.0 — 2026-09-19

### New

- Export without base64 images, and open it with a run summary

## 1.103.1 — 2026-09-19

### Fixed

- Tell a caller WHY its callee failed, with a class it can act on

## 1.103.0 — 2026-09-18

### New

- Sign each claude configuration in and out

### Fixed

- Offer sign-in for a workflow node under that node's own profile

## 1.102.2 — 2026-09-18

### Fixed

- Draw the builder's chat with the chat surface's own transcript

## 1.102.1 — 2026-09-18

### Fixed

- Keep a run's call token, rename workflow threads, page to what is visible

## 1.102.0 — 2026-09-18

### New

- Change a workflow by talking to an agent in a docked chat

### Fixed

- Let the first message be sent, and open one chat per workflow

## 1.101.1 — 2026-09-17

### Fixed

- Stop await_agent from timing out on the caller's transport

## 1.101.0 — 2026-09-17

### New

- Open a native terminal panel instead of the external terminal app
- Ask a task's agent for screenshots in the chat as well as the report
- Rename and colour terminal tabs

## 1.100.0 — 2026-09-17

### New

- Open a call's full context readout from its footer ring

## 1.99.5 — 2026-09-17

### Fixed

- Show geniro's own tool calls that draw no card of their own

## 1.99.4 — 2026-09-17

### Fixed

- Let the autopilot start a workflow whose agent nodes all run on auto

## 1.99.3 — 2026-09-17

### Fixed

- Keep a pointer where an earlier call of a continued conversation was made

## 1.99.2 — 2026-09-17

### Fixed

- Offer sign-in for an expired claude token, and restart sessions after it

## 1.99.1 — 2026-09-17

### Fixed

- Keep a turn open until every message written into it is taken

## 1.99.0 — 2026-09-17

### New

- Message a running call's callee directly from its call card

### Fixed

- Centre the call card footer between its rule and the card edge

## 1.98.1 — 2026-09-16

### Fixed

- Deliver callee questions to a busy caller, images on workflow start, calmer agents panel
- State every agent's and call's spend over the whole run
- Resume a cursor turn whose connection dropped instead of failing it
- Never prepend the same older history page twice
- Title a call card whose start is above the window, and drop phantom ones
- Thread loading state, root-only workflow previews, async-first calls
- Offer skills in an open workflow run's composer
- Measure the auto-compact baseline from the first reading after a compaction
- Collapse a call card from its footer, one type size in the footer

## 1.98.0 — 2026-09-16

### New

- Agent call titles, merged call threads, board reorder and label instructions

### Fixed

- Draw an agent call as its own card, titled by the caller

## 1.97.0 — 2026-09-15

### New

- Auto-compact a chat once its context reaches a chosen share of the window
- Auto-compact an agent node at a chosen share of its window

### Fixed

- Keep auto-compaction armed when a compaction is stopped
- Replace the kept process after a carried compaction

## 1.96.0 — 2026-09-15

### New

- Let the agent report and move its card through a board tool

### Fixed

- No empty callee block under a caller already waiting on it
- Place every live row once, in the block it belongs to

## 1.95.0 — 2026-09-15

### New

- Remember folds and the agents panel per thread

## 1.94.2 — 2026-09-15

### Fixed

- Settle continuation-answered calls, bound resumed costs, page history, fold panel - spawn-cli: a turn whose prompt was answered inside a continuation now   settles when the CLI goes idle (or at the silence deadline) instead of   being failed with "produced nothing for 30 minutes" — traced on run   a0877ce9, where a finished callee reached its caller as CALLEE_FAILED. - claude cost: a resumed process restores the session's running total, and   a workflow node's calls share one session; cap the per-turn step at the   turn's own calibrated token price plus its delegates. - call card: print the context reading beside the ring, not in/out tokens. - transcript: page older items while the loaded rows do not fill the pane,   and make the notice a Load earlier messages button. - agents panel: sub-agents, terminals and tasks are collapsible blocks with   counts; finished work folds and completed tasks hide behind a toggle.

## 1.94.1 — 2026-09-14

### Fixed

- Keep a card's report and task chip current, and add projects from Settings

## 1.94.0 — 2026-09-14

### New

- Announce endings with a command running, withdraw them if the run resumes

## 1.93.9 — 2026-09-14

### Fixed

- Offer every slash command and refresh the list as a command is typed

## 1.93.8 — 2026-09-14

### Fixed

- Keep chat status, terminals, sub-agents, tasks and context consistent
- Delegate shells off terminals, workflow run counts, notify after close

## 1.93.7 — 2026-09-14

### Fixed

- Keep a thread working through a continuation's mid-turn result

## 1.93.6 — 2026-09-14

### Fixed

- Keep the sub-agents chip count current from the broadcast

## 1.93.5 — 2026-09-14

### Fixed

- Hold a turn's ending only while a just-launched command runs
- Announce endings only when nothing is left running

## 1.93.4 — 2026-09-14

### Fixed

- Timeline counts what the agent said, stays live, marks the current step

## 1.93.3 — 2026-09-14

### Fixed

- End a turn on its continuation, and stop losing rows to SQLite

## 1.93.2 — 2026-09-14

### Fixed

- Fold a call's rows back into its block, redesign instances, per-node context
- Keep a workflow node's last context and plan reading

## 1.93.1 — 2026-09-14

### Fixed

- Give every instance of an agent its own context ring
- Show a node's older calls, and keep a callee's last status
- Don't call a callee stalled while its own tool call runs
- Refuse a folder macOS will not let Geniro read, and say why

## 1.93.0 — 2026-09-13

### New

- Keep a snapshot of the workflow each run started with

### Fixed

- One process per callee conversation, and calls that survive a restart
- Stop filing quoted pull requests under a thread, and pulled work as its changes
- Close every call's work, block nested owners, and capture prefixed PR commands
- Record an automatic compaction in the transcript
- Draw every call instance in the agents panel in one shape
- Never settle a turn on a continuation's result, capture cursor PRs, drop the PR reset
- Keep a workflow run's agent processes alive between replies
- State the agent card's spend from the thread totals
- Let a queued message be sent now into a running workflow
- Show a still-working callee at the end of the transcript
- Keep the Terminals chip on the run's live shell count

## 1.92.2 — 2026-09-13

### Fixed

- Decode entity file URLs so an install path with a space boots
- Close the sub-agents and commands a finished workflow left out
- Stage an update beside the app and put it in place at quit

## 1.92.1 — 2026-09-12

### Fixed

- Keep one agent's turn in one block and title task cards from the run's fold
- Read a node's liveness off node_state past the history window, and title agent blocks
- List only the thread's own pull requests in the agents panel

## 1.92.0 — 2026-09-12

### New

- Split a called agent into its instances in the agents panel
- Ask a task's agent for screenshots and attach them to the card

### Fixed

- Load entities from a path with a space in it
- Announce a workflow run's awaiting state at every transition

## 1.91.0 — 2026-09-12

### New

- Move a card to done when its pull request is merged

### Fixed

- Decode file URLs when loading entities
- Put a failed card back to work when its run works again

## 1.90.0 — 2026-09-12

### New

- Ask a task's agent for a pull request, and show it on the card
- Name the pull request on the board card

### Fixed

- Make a task's report the LAST thing its agent sends
- Decode entity file URLs instead of reading their raw path

## 1.89.1 — 2026-09-12

### Fixed

- Name a task's repository, keep its chat working, stage new-task images

## 1.89.0 — 2026-09-12

### New

- Send a follow-up message to a workflow run
- Delete a task from its detail panel
- Split a workflow's Sub-agents chip into one block per agent

### Fixed

- Load MikroORM entities from a path containing a space
- Render a local markdown image whose path contains spaces
- Wake a caller whose callee asks or finishes after it ended
- Let a long folder path shrink in the task panel
- File a task run under the group claiming the card's folder
- Keep the CLI after Stop when it ended the stopped turn itself
- Make Retry re-send the interrupted message on every CLI
- List only uncommitted files once the checkout left the start
- Leave a stopped task to the user instead of the autopilot
- Keep a task's worktree until its card is Done

## 1.88.0 — 2026-09-11

### New

- Attribute a render card to the delegate that drew it

## 1.87.0 — 2026-09-10

### New

- Stop running commands, plus nine chat-surface fixes

## 1.86.0 — 2026-09-08

### New

- Give a card its own agent, its own thread and its own report

### Fixed

- Close the review findings on the board's run targets

## 1.85.0 — 2026-09-07

### New

- Let each task name its own folder, defaulting to the project's

### Fixed

- Make the conversation timeline's hover visible, on the whole node

## 1.84.0 — 2026-09-07

### New

- A conversation timeline above the transcript

### Fixed

- Make Retry work on claude, by re-sending the interrupted message

## 1.83.0 — 2026-09-07

### New

- The autopilot — a main-process conductor with a real cap

## 1.82.0 — 2026-09-07

### New

- Run a task by hand — worktree, chat and report
- Collect a settled run's worktree, and close the run-edge bypass

### Fixed

- Bound the worktree delete, and close the run lifecycle gaps
- Bound the worktree delete against symlinks, drop the settle prune
- Centre the New task glyph, and rebuild the detail panel

## 1.81.1 — 2026-09-07

### Fixed

- Re-read the library when the screen comes back into view

## 1.81.0 — 2026-09-07

### New

- Add the tasks board — projects, columns, drag and keyboard moves
- Richer cards — labels, description preview, dates
- Priority and due dates, and a card dense enough to triage
- Columns become surfaces, with a per-column add
- The project switcher moves into the board header

### Fixed

- Settle the review round — stale board, refetch scope, fixtures
- Say when Run task arrives, per the spec
- Open the picker downward, and stack the project over its folder

## 1.80.0 — 2026-09-07

### New

- Pin threads to the top of their own group
- Two controls on a chat row, the rest on right-click

### Fixed

- Two specs that could only ever fail on macOS

## 1.79.0 — 2026-09-07

### New

- Show what a turn is spending, while it is spending it

### Fixed

- Show what a callee is doing, and say when it stops
- Draw the callee's context ring while the call is still open
- Cap the open picture against the viewport, not an unresolvable percentage
- Say nothing about a thread's cost when nothing measured it

## 1.78.0 — 2026-09-06

### New

- Store projects and tasks, and regenerate the client

### Fixed

- Give every live card in a column its own position
- Correct the position docs, drop the orphaned allocator, pin the query DTO
- Settle the five deferred findings on projects and tasks

## 1.77.0 — 2026-09-06

### New

- Retry a failed turn without replaying its prompt

## 1.76.0 — 2026-09-06

### New

- Search one conversation, export it, and see what changed since it started
- A washed landing row, and the changed files as a tree with line counts
- The changes control and every pull request state their own size
- The folder's changes lead the shelf, and each pull request states its files

## 1.75.0 — 2026-09-05

### New

- Per-agent worked time and tool count, and a deceptive-text gate

## 1.74.0 — 2026-09-05

### New

- Give every agent-to-agent call its own durable ring

## 1.73.1 — 2026-09-05

### Fixed

- Resolve the window at every durable write path

## 1.73.0 — 2026-09-03

### New

- Offer each agent CLI its own update on its card

### Fixed

- Drop the disabled placeholders from claude's model list

## 1.72.1 — 2026-09-03

### Fixed

- Write the MCP toggle into the profile the panel listed
- Derive the profiled MCP-toggle fixture from the shared one
- Make background work visible, and honest, on both CLIs

## 1.72.0 — 2026-09-03

### New

- Report a cursor thread's cost while the turn is still running
- Let a workflow run be archived, like any other thread
- Say which model each sub-agent is running

### Fixed

- Keep callee sessions alive and make a run's cost readable
- Tell the archive dialog what a WORKFLOW run's archive costs
- Keep a question card alive past the caller's 60-second deadline
- Apply the workflow-run observability review findings

## 1.71.3 — 2026-09-02

### Fixed

- Let the opened picture be right-clicked and copied

## 1.71.2 — 2026-09-01

### Fixed

- Clear a question card its agent has stopped waiting for
- Keep ONE process per conversation, not per turn

## 1.71.0 — 2026-09-01

### New

- Show what each sub-agent cost

### Fixed

- List a background command whose tool this fold did not name

## 1.70.3 — 2026-09-01

### Fixed

- Re-place a submenu when the pointer moves to another row

## 1.70.2 — 2026-08-31

### Fixed

- Let agent prose take the transcript's whole width

## 1.70.1 — 2026-08-31

### Fixed

- List only the main thread's terminals
- Fold the finished sub-agents away

## 1.70.0 — 2026-08-31

### New

- Delete archived chats on a retention window

## 1.69.0 — 2026-08-31

### New

- Archiving asks first, and the queue can be paused

### Fixed

- The twelve defects from one feedback pass

## 1.68.0 — 2026-08-31

### New

- Add a dev-only component catalog and mechanize the story rule
- Group the settings rows and pick a theme by its own palette
- Repaint on direction A and enclose both settings subpages
- Rule the Stats page into surfaces, and fix the two figures it got wrong
- Draw the data edge, and open the palette
- A reading measure for agent prose, and a transcript that grows up

### Fixed

- Render CliLoginProgress stories in their real hosts
- Give the error banner its own surface and stop the boundary overflowing
- Stop both settings lists saying they are empty twice
- List named profiles in the picker, and make the default row a choice
- Line up the configuration rows and stop cutting the path's tail
- Make the builder's counts mean what they say, and stop shouting delete
- One edge for a selected node, and nothing straddling it
- One money format per job, and no badge that repeats the name

## 1.67.0 — 2026-08-31

### New

- Zoom the image viewer, and a show_gallery render tool

## 1.66.0 — 2026-08-30

### New

- Shelf counters, thread-list labels, named claude configurations

## 1.65.0 — 2026-08-30

### New

- Archive threads, and reach the one-way delete from the archive
- The archive filter is an icon, and it has three scopes

## 1.64.0 — 2026-08-30

### New

- A dark theme, and themes as files the whole app reads
- The ANSI bright half is eight tokens of its own

## 1.63.0 — 2026-08-30

### New

- Fast actions — named prompts you drop into the composer

## 1.62.0 — 2026-08-30

### New

- A dynamic workflow's fleet, reachable from the shelf and the panel

## 1.61.1 — 2026-08-30

### Fixed

- One pull request above the composer, the state in its icon

## 1.61.0 — 2026-08-30

### New

- Show the pull requests a thread OPENED, not its branch's

### Fixed

- Stop the preamble sending an agent off to draw its own chart

## 1.60.2 — 2026-08-30

### Fixed

- Give every response DTO one OpenAPI component name
- Stage the packaged trees from the lockfile, not the registry

## 1.60.1 — 2026-08-29

### Fixed

- Separate context-meter ring from chips

## 1.60.0 — 2026-08-29

### New

- Host-rendered findings card over geniro's own MCP tool
- Show_chart, the render family's second tool
- Propose_patch, the render family's first side effect
- Propose_plan, a gate before the work
- Show_metrics, the render family's scorecard
- Show_comparison, the render family's decision table

### Fixed

- The transcript tail never followed a streaming turn
- Make the scorecard read like one
- Audit the host tool descriptions as a SET

## 1.59.0 — 2026-08-29

### New

- Show the repo's pull requests in the thread and its panel
- Scope the pull-request panel to the thread's own branch

### Fixed

- Write the two CLI-answer caches synchronously

## 1.58.1 — 2026-08-29

### Fixed

- Builder polish — palette, popovers, calls card, MCP, layout

## 1.58.0 — 2026-08-28

### New

- Fold the profile into the model-settings panel

## 1.57.0 — 2026-08-28

### New

- Keep a run's CLI process for three hours, not thirty minutes

## 1.56.0 — 2026-08-28

### New

- Grow a prompt field with its text, up to ten lines

### Fixed

- Make every fact about a thread reach every window
- Stop reading a cursor delegate's LAUNCH as its ending
- Size a menu panel to its longest row

## 1.55.0 — 2026-08-28

### New

- Export a whole thread to a file

## 1.54.0 — 2026-08-28

### New

- Open a plain terminal in the chat's folder

## 1.53.4 — 2026-08-28

### Fixed

- The account a turn runs on follows the folder's pin

## 1.53.3 — 2026-08-27

### Fixed

- Key the stored metrics reading by the run's profile

## 1.53.2 — 2026-08-27

### Fixed

- Four defects from the thirteenth feedback pass

## 1.53.1 — 2026-08-27

### Fixed

- Key every account-level answer by the run's profile

## 1.53.0 — 2026-08-27

### New

- Switch a live chat's account, and three smaller readings

### Fixed

- The twelfth feedback pass — six defects, one per screenshot
- The profile a turn actually runs under, and three more

## 1.52.1 — 2026-08-27

### Fixed

- The eleventh feedback pass — one queue, one status word, one context reading
- The eleventh pass's review findings, and what reviewing them found

## 1.52.0 — 2026-08-25

### New

- Instruction blocks wired to the agents they apply to

## 1.51.1 — 2026-08-25

### Fixed

- The tenth feedback pass — what is still running, and what is over

## 1.51.0 — 2026-08-24

### New

- Show the shells an agent is running, with the terminal behind each

### Fixed

- The ninth feedback pass — when a turn is over, and where a fact belongs

## 1.50.0 — 2026-08-24

### New

- A way back to the tail, and lists behind the header's counts

### Fixed

- Mark an unseen thread on the ROW, not just with a dot
- The eighth feedback pass — what a turn shows and what it costs to load

## 1.49.3 — 2026-08-22

### Fixed

- Keep the context-window chip a picker at the model default
- Offer the worktree that holds a branch, not git's fatal line

## 1.49.2 — 2026-08-22

### Fixed

- Stop a chat sticking on "still working" after its CLI is reaped

## 1.49.1 — 2026-08-22

### Fixed

- Close out the second TickTick defect list
- Close out the pass-six review findings

## 1.49.0 — 2026-08-22

### New

- Name a chat once its first turn ends

## 1.48.5 — 2026-08-20

### Fixed

- Stop publishing a release before its macOS archive

## 1.48.4 — 2026-08-20

### Fixed

- Stop the window scrolling, and fix the chat list's preview & order

## 1.48.3 — 2026-08-20

### Fixed

- Rebuild the window title bar as one band

## 1.48.2 — 2026-08-20

### Fixed

- Timeout hung installs & sweep debris

## 1.48.1 — 2026-08-19

### Fixed

- Close out the twelve reported defects
- Close out the eighteen review findings

## 1.48.0 — 2026-08-19

### New

- Start chats from saved run configurations
- Hang saved configurations off the +, and stop pickers wrapping

### Fixed

- Clear a run-configuration refusal once it is resolved
- Strip an inherited CLAUDE_CODE_ENABLE_CFC from spawned children

## 1.47.0 — 2026-08-19

### New

- Custom instructions for every provider, and tell the agent where it is

## 1.46.2 — 2026-08-18

### Fixed

- Close out the sixteen reported defects
- Close out the fourteen reported defects

## 1.46.1 — 2026-08-17

### Fixed

- Close out the eight reported defects
- Close out the nine defects from the second review pass

## 1.46.0 — 2026-08-17

### New

- Follow the ledger live
- Remember the rail, and make a silent notification diagnosable

### Fixed

- Announce only an update that can actually be installed
- Make the readouts tell the truth while an agent is working

## 1.45.0 — 2026-08-17

### New

- Apply releases in the app instead of naming a brew command

### Fixed

- Drop the deprecated cask macos comparison, and fix the gate comment

## 1.44.0 — 2026-08-16

### New

- Show what the context window holds, not just how full it is
- Give cursor chats a real context breakdown, off its own store
- Give a workflow node its own reasoning effort
- Continue a session the CLI already holds
- Add a usage ledger and a Stats page
- Redraw the Stats page on Recharts
- Break spend down by workflow

### Fixed

- Stop reading a killed agent as a turn the user cancelled
- Stop a node adopting the other CLI's model, and its canvas from opening at 4x
- Widen the session picker, drop its folder scope, open its menu downward
- Apply the context-metrics review findings, and the self-review's own
- Agree the turn count with its noun
- Close the gaps on idle days, and lift the breakdowns into view

## 1.43.0 — 2026-08-15

### New

- Tell the user outside the app when a thread asks or ends

## 1.42.0 — 2026-08-15

### New

- Drop the move-to-group control, and make group options a panel

## 1.41.1 — 2026-08-15

### Fixed

- Make the whole group a drop zone, and calm the drop highlight

## 1.41.0 — 2026-08-15

### New

- Group threads in the sidebar, and move them by dragging

## 1.40.0 — 2026-08-15

### New

- Show how long each turn worked, and the thread's total

## 1.39.2 — 2026-08-14

### Fixed

- Read a run's settle MOMENT from its terminal item, not its row

## 1.39.1 — 2026-08-14

### Fixed

- Move the current task list to the side panel, and stop stale spinners

## 1.39.0 — 2026-08-14

### New

- Show the agent's own task list instead of a nameless tool row

## 1.38.3 — 2026-08-14

### Fixed

- Let the context ring keep the window a silent turn never spoke about

## 1.38.2 — 2026-08-14

### Fixed

- Work the CLI does after its turn settles belongs to the run

## 1.38.1 — 2026-08-14

### Fixed

- Hold a claude session's first prompt until its MCP servers are up

## 1.38.0 — 2026-08-14

### New

- Render the images agents reference from their own markdown

## 1.37.10 — 2026-08-14

### Fixed

- A turn waiting on the user has not gone silent
- A delegate that has spoken since the run settled is working

## 1.37.9 — 2026-08-13

### Fixed

- Keep a live row's clock, and stop a replay settling a running run

## 1.37.8 — 2026-08-13

### Fixed

- A turn is not over while its background work is still out

## 1.37.7 — 2026-08-13

### Fixed

- Stop dressing the between-turn hand-over as a failure

## 1.37.6 — 2026-08-13

### Fixed

- Say a run needs you, in the sidebar you are not looking at

## 1.37.4 — 2026-08-13

### Fixed

- Give the agent card one status line, and the list its own header

## 1.37.3 — 2026-08-13

### Fixed

- Give the thread list an icon of what it opens, not of which way

## 1.37.2 — 2026-08-13

### Fixed

- Make a block header hover as one row, measured rather than eyeballed

## 1.37.1 — 2026-08-13

### Fixed

- Let a delegate's rows be the delegate's, and make the ask visible

## 1.37.0 — 2026-08-13

### New

- Let a cursor delegation be a sub-agent, not a nameless tool row

## 1.36.0 — 2026-08-13

### New

- Verify the one server a switch just turned on, instead of saying "unknown"

## 1.35.3 — 2026-08-13

### Fixed

- Give cursor's MCP rows a real switch, not a padlock

## 1.35.2 — 2026-08-13

### Fixed

- One shutdown per crash, not a shutdown loop that ends in OOM

## 1.35.1 — 2026-08-13

### Fixed

- Keep the conversation, and end the process the turn is over

## 1.35.0 — 2026-08-13

### New

- A real reasoning-effort picker, and stop writing the user's cursor config

## 1.34.1 — 2026-08-13

### Fixed

- Show the effort each cursor model carries, and say where it changes

## 1.34.0 — 2026-08-12

### New

- Sign a CLI in and out without opening a terminal window

## 1.33.2 — 2026-08-12

### Fixed

- Say WHICH profile the account row is reporting on

## 1.33.1 — 2026-08-12

### Fixed

- Let the account control say which account state it is in

## 1.33.0 — 2026-08-12

### New

- Give each tool call the icon of the work it did

### Fixed

- Collapse the compaction summary into a system line
- Keep the compacted line still when it opens
- Let a cursor turn say what it actually did
- Say why cursor cannot reopen a conversation, instead of showing nothing
- Drop the standing "no sub-agents" caveat from the agents panel
- Say why a cursor chat has no context meter
- Give the context ring the same box as the controls beside it

## 1.32.0 — 2026-08-12

### New

- Drop the Cursor API key for CLI login, and move sign-in to Settings

## 1.31.0 — 2026-08-12

### New

- Let the sub-agent blocks speak for themselves

## 1.30.2 — 2026-08-12

### Fixed

- Name a compaction while it runs, surface its summary, and stop cursor rows showing {}

## 1.30.0 — 2026-08-11

### New

- Surface background sub-agents as first-class UI

## 1.29.1 — 2026-08-11

### Fixed

- Stop a cancelled turn leaking into the next one, and repair the handoff script

## 1.29.0 — 2026-08-11

### New

- Add agent configDir (per-chat/profile)

## 1.28.0 — 2026-08-11

### New

- Show model loader and effort readout

## 1.27.5 — 2026-08-11

### Fixed

- Answer between-turn requests instead of denying them in the user's name
- Stop reporting a permission-channel failure when a tool merely quotes one
- Close the three upstream findings from #32, each re-probed first
- Answer multi-select questions, and correct what declining cost
- Stop spending the turn's one notice on refusals the agent absorbs

## 1.27.4 — 2026-08-11

### Fixed

- Keep sub-agent work out of the parent, list cursor models, offer CLI sign-in

## 1.27.3 — 2026-08-10

### Fixed

- Launch through turbo, so `pnpm dev` builds the daemon it runs

## 1.27.2 — 2026-08-10

### Fixed

- Answer the send-now press, name the delegate, and stop the badge lying

## 1.27.1 — 2026-08-10

### Fixed

- Attribute sub-agent output, drop blank table headers, stop serving a stale daemon
- Keep the live tail to one thread, and guard replacing a daemon in use

## 1.27.0 — 2026-08-10

### New

- Hold a mid-turn message instead of injecting it, and steer on purpose
- Report the CLI's context compaction, and say only what it tells us
- Let a screenshot answer the agent's question
- Say out loud that a question was parked between turns

### Fixed

- The six UI defects a screenshot sweep found, and the one it didn't
- State what the CLI keeps for itself, instead of listing servers it never loads
- Answer a lone question on the CLI's `answers` channel, not `response`
- Refuse the approval requests the transport was dropping, and record the exchange
- Apply the round-1 review, and correct the three it got wrong
- The self-review found the id keying had traded one silent send for another

## 1.26.0 — 2026-08-07

### New

- A debug log the app can show and a file it can keep
- The real Chrome DevTools, one inspector per process
- Inspect by default in dev, and delete the legacy it found

### Fixed

- The seven reported UI/transcript defects
- The two overflow defects a browser found, and a real DevTools panel

## 1.25.0 — 2026-08-06

### New

- Send on Enter, follow the tail, and name what the tools did
- Change the approval mode on the turn already running
- Split the composer controls, and put the context meter by Send
- Give an adapter a session, so a run can keep its CLI process
- Keep a chat's CLI process between its turns
- Tell a server that needs signing in apart from one that is broken
- Redesign the MCP list, and let a signed-out server be signed in to

### Improved

- Answer the MCP panel from the turn that already reported

### Fixed

- Settle a turn whose `close` never arrives
- Apply the round-1 review findings for the run-scoped CLI session

## 1.24.0 — 2026-08-06

### New

- Hand the conversation to the user's own terminal, and delete the mirror
- Instance lock, child journal, idle shutdown

### Fixed

- Follow the running turn, and switch MCP through the CLI's own config
- Say what the agent is doing, and send follow-ups into the running turn

## 1.23.2 — 2026-08-05

### Fixed

- One transcript row per ACP block, and per-CLI approval modes

## 1.23.1 — 2026-08-05

### Fixed

- Type-check the specs, and fix the 132 errors that had accumulated

## 1.23.0 — 2026-08-05

### New

- Mirror the running turn live, instead of a second session

## 1.22.3 — 2026-08-05

### Fixed

- Persist the context window, and put MCP behind a button

## 1.22.2 — 2026-08-05

### Fixed

- Live activity indicator, per-stretch thinking, real context window

## 1.22.1 — 2026-08-04

### Fixed

- Apply the agent-mcp-sidebar review findings
- Self-review round — drain stderr, stream-decode stdout, order the version memo

## 1.22.0 — 2026-08-03

### New

- List a cursor agent's MCP servers

### Fixed

- Review round 1 — cursor's disabled state, and honest degradation

## 1.21.0 — 2026-08-03

### New

- Per-node plugin directory with its own MCP list

### Fixed

- Stop geniro being the silent one about a plugin directory
- Read a failed MCP row through whichever glyph the CLI drew

## 1.20.0 — 2026-08-03

### New

- Let a project-scope MCP server be switched off per agent

### Fixed

- Close the MCP switch's silent-no-op and scope gaps
- Honour the trust-prompt refusal, and stop a stale read undoing a toggle

## 1.19.0 — 2026-08-03

### New

- Show each agent's MCP servers in the chat sidebar

### Fixed

- Correct the MCP listing's failure, refresh and reaping semantics
- Stop the MCP panel asserting things it never checked
- Pin the MCP listing's ordering and reaping in tests, not comments

## 1.18.0 — 2026-08-02

### New

- Closeable error strip, and a way out when a run's workflow is gone

### Fixed

- Deliver pasted images over ACP instead of silently dropping them

## 1.17.0 — 2026-08-02

### New

- Drive cursor-agent over ACP behind an opt-in flag

### Fixed

- Resolve the 14 ACP transport review findings
- Harden the cursor MCP cleanup and the call-surface gate
- Correct the round-1 cleanup fixes and pin them for real

## 1.16.0 — 2026-08-02

### New

- Delete workflow runs, and make the composer footer fit

## 1.15.0 — 2026-08-02

### New

- Pasted images, CLI-sourced model lists, composer chip row
- Live streaming, question cards, code blocks, CLI-sourced commands
- Fix 16 reported chat-UX defects across transcript, composer and run lifecycle

### Fixed

- Report real context + window, and let a chat switch model mid-run

## 1.14.0 — 2026-07-27

### New

- Add git branch & folder pickers

## 1.13.0 — 2026-07-24

### New

- Add agent description for caller routing

## 1.12.0 — 2026-07-24

### New

- Autosave, status bar, and delete confirmation

## 1.11.1 — 2026-07-23

### Fixed

- Deny a parked CLI when an approval_request card fails to persist

## 1.11.0 — 2026-07-23

### New

- Chat permission plane — approval modes end-to-end (milestone 1, wip)

### Fixed

- Resolve chat permission-plane review findings (milestone 1)

## 1.10.1 — 2026-07-21

### Fixed

- Implement whole-repo review findings (42 actionable, F1-F49)
- Apply round-1 self-review findings
- Make route-template labels real via a Fastify onRequest stamp
- Resolve the deferred review findings (F2/F3/F32/F39/F43/F57/F62 + D-items)

## 1.10.0 — 2026-07-20

### New

- Slash-skill autocomplete in the composer — the target agent's skills as you type
- Harvest claude's own slash_commands report into the skills list

## 1.9.0 — 2026-07-19

### New

- Move workflow rename into a popup, regroup the builder toolbar
- Make the workflow meta button icon-only 'Change workflow'
- Visible grip on panel resize handles
- Per-node delete button on the canvas card
- Drop the CLI-default model option — nodes always name a model
- Redesign — minimal sidebar, centered new-run composer with trigger
- Cursor-style new-run composer card
- Composer suggestion chips + remembered last target
- Call_agent thread continuation + live sidebar run statuses
- Rich sidebar run list — labels, rename, live status, previews
- Transcript header redesign + live agents panel
- Generic side-panel toggle + context fill ring
- Per-agent thread lists with per-thread terminals in the panel
- Terminal mirror opens as a modal popup
- Queue messages written while the agent is working
- Run composer matches the create card; queues persist per run
- Grouped tool rows, file-edit diffs, readable statuses, expandable errors
- Fold each agent call into one nested sub-turn block
- Request → result framing for call blocks
- Messenger-style transcript — initials avatars, sender lines, time metadata
- Align the transcript 1:1 with geniro web's thread design
- Markdown everywhere + one turn block per agent, geniro-style

### Fixed

- Match daemon health-check status to the real HealthStatus.Ok wire value
- Stop works again and workflow terminal states tell the truth
- A post-cancel cli error settles as turn_cancelled
- Quieter flow — no started rows, bare tool headers, whole exchange in the call card
- Approval cards get the asking agent's frame; clean finishes go silent

## 1.8.2 — 2026-07-10

### Fixed

- Harden daemon/UI runtime and IPC reliability

## 1.8.1 — 2026-07-07

### Fixed

- Apply agent-to-agent-calls M1–M4 code-review findings

## 1.8.0 — 2026-07-07

### New

- Bridge a callee's questions to the calling agent (M4)

## 1.7.0 — 2026-07-07

### New

- Cursor caller leg — MCP-trust probe, mcp.json merge/restore, visible degrade (M3)

## 1.6.0 — 2026-07-07

### New

- Agent-to-agent call runtime for claude callers (M2)

## 1.5.0 — 2026-07-06

### New

- Library cards, geniro-style builder, typed node schema + manual triggers
- Show the inspector only for a selected node, make it resizable
- Per-node validation + collapsible typed ports on node cards
- Persist per-workflow canvas viewport (pan + zoom)
- Per-agent model select in the inspector; agent kind fixed per node
- Call edges — strict kinds, validation, canvas statics (M1)

### Fixed

- Never crash the renderer on an unknown node kind + root error boundary
- Geniro-style collapsed ports — symmetric two-line summary pills
- Geniro-style ports toggle — 18px circle on the header divider
- Align port labels left on both sides, move the toggle below the ports block
- Equal-width port labels — every pill fills its flex-1 column

## 1.4.3 — 2026-07-05

### Fixed

- Report the release version instead of a hardcoded 0.1.0

## 1.4.1 — 2026-07-04

### Fixed

- Make brew install yield a launchable app + repair CI macOS build

## 1.4.0 — 2026-07-04

### New

- Brew + curl install, release-time app packaging, no-Apple update flow

## 1.3.0 — 2026-07-04

### New

- M4 pty terminal mirror, settings, auto-update + macos packaging

### Fixed

- Refetch the workflow library when the chats tab becomes visible
- Apply M4 whole-repo review findings

## 1.2.0 — 2026-07-03

### New

- M3 workflow graphs + dag fan-out execution

## 1.1.0 — 2026-07-03

### New

- M2 single-agent headless chat (claude + cursor)
- Reskin in Geniro's warm theme + restructure onboarding to per-agent config
- Standardize the renderer design system on Tailwind v4 + tokens
- Brand the app as Geniro — name + icon
- Make the app icon a macOS squircle
- Add app shell — collapsible nav, Settings, per-chat folder

### Fixed

- Harden M2 child-process lifecycle and close test gaps
- Replace broken tsx dev script with nodemon + swc + Electron-node watch loop
- Reflect real agent readiness in onboarding
- Make the Geniro dev name actually stick (bundle id + LS refresh)
- Rename the dev bundle to Geniro.app so the Dock name sticks

## 1.0.0 — 2026-06-30

### New

- Local-first Electron shell + NestJS daemon over cloned Geniro packages
- Milestone 1 shell & infra
- Move daemon to apps and add shell contracts
- Harden UI main process and IPC
