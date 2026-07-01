---
tier: T1.5
producer: plan
schema-version: 1
branch: main
timestamp: 2026-06-29T09:04:18Z
geniro_kind: design-doc
geniro_schema_version: m5-v1
task_slug: geniro-app-v1
topic: "Local-first macOS app (Electron + TS daemon) to compose and run a DAG of CLI coding agents"
mode: IDEA
effort_tier: big
lifecycle: approved
budget:
  max_files_to_edit: null
  max_lines_changed: null
  time_budget: null
checkpoints:
  - {step_anchor: step-1, name: "M1 — daemon boots, /health ok, onboarding passes"}
  - {step_anchor: step-2, name: "M2 — single-agent chat round-trip persisted+resumable"}
  - {step_anchor: step-3, name: "M3 — graph DAG fan-out runs end-to-end"}
  - {step_anchor: step-4, name: "M4 — terminal mirror + electron-updater + signed DMG"}
forbidden_actions:
  - "do NOT bundle a Python runtime — the whole stack is TypeScript"
  - "do NOT write API tokens/secrets into SQLite or any file — macOS Keychain only"
  - "do NOT store graph definitions in SQLite — YAML files are the source of truth; SQLite is runtime/history only"
  - "do NOT add tmux/PTY-scraping for graph execution in v1 — graph nodes run headless"
  - "do NOT add cloud/remote/multi-machine code paths — local single-machine only"
tools_required: ["node", "pnpm", "git", "claude", "cursor-agent"]
parent_spec: geniro-app-v1
---

<!-- geniro:design-doc -->
<!-- Hardened 2026-06-30 during M2 Phase-1 spec-challenge: folded in cwd transport (security), persist-then-emit + reconnect-replay seam, child-process lifecycle, and defensive Cursor resume. Approved design unchanged. -->

# geniro v1 · Milestone 2 — One agent in chat (headless)

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Define the unified agent-adapter contract and drive Claude and Cursor headlessly, exposing a full-screen single-agent chat with persisted, resumable history — with the agent scoped to the user's chosen project folder.

## 2. Scope — Included

- `Executor` interface + normalized event model (TextChunk/ReasoningChunk/ToolCallRequest/ToolCallComplete/TurnComplete/TurnCancelled/Error) ported in spirit from `inner/executor.py:518-596` and the wire `session.*`/`response.*` shapes (`schemas.py:3681-3739`).
- Claude headless adapter: spawn `claude -p --output-format stream-json --verbose --input-format stream-json`, parse NDJSON → events; auth via `ANTHROPIC_API_KEY`/subscription; model + `--resume` (`code.claude.com/docs/en/headless`). NDJSON input requires user-message JSON lines (`{"type":"user","message":{role,content}}`), not plain text.
- Cursor headless adapter: spawn `cursor-agent -p --output-format stream-json`, defensive version-tolerant NDJSON parser; auth via `CURSOR_API_KEY`; `--force`/`--approve-mcps` handling (`cursor.com/docs/cli/headless`).
- **Defensive NDJSON parsing (both adapters).** Buffer stdout and split on newlines, tolerating a JSON object split across chunks; type-discriminate each line and **ignore unknown event types** — even Claude emits `rate_limit_event`, `hook_*`, and `post_turn_summary` lines that must be skipped without crashing.
- Persistence: write conversation `items` (normalized 11-kind taxonomy, `conversation.py:584-610`) + `node_state` (CLI session id for resume) to SQLite; in-proc pub-sub bus streaming to the renderer (`session_stream.py:1-108`). **Persist-then-emit ordering:** each item is written (allocating its monotonic `seq`) BEFORE it is published on the bus, so the durable transcript is the source of truth and nothing is lost when no client is attached.
- **Per-run working directory (security).** The user's chosen project folder is carried to the daemon as the run's `cwd` (a validated field on the run, e.g. `Run.cwd`); adapters spawn the CLI with that `cwd` so the agent is scoped to the user's project — **never** the daemon's own cwd (the app repo, `.git`, `.codegraph`). The daemon validates the path (exists, is a directory) before spawning.
- **Child-process lifecycle.** The daemon keeps a registry of spawned CLI processes and kills them on run-cancel and on daemon shutdown (`OnApplicationShutdown`), so no `claude -p`/`cursor-agent -p` orphans mid-turn.
- Chats page (single agent): full-screen dialog, send messages, stream rendered transcript, **reconnect to an in-flight run after window restart by replaying persisted `items` (≤ last seen `seq`) then attaching to the live stream filtered to `seq` greater than the last replayed** (no drop, no duplicate at the seam); the renderer joins a per-run WS room.

## 3. Scope — Excluded

- No graph/DAG yet (M3) — this is a single agent, not a team.
- No PTY terminal/auto-update/packaging (M4).

## 4. Assumptions

- macOS; the M1 daemon + SQLite store from milestone-1 are in place.
- The CLIs accept the documented headless flags and emit a parseable NDJSON stream with usage. (Validated live: claude 2.1.196, cursor-agent 2025.09.18-7ae6800.)
- Claude `stream-json` stable; Cursor schema pinned to the tested version.
- The user has chosen a project folder during M1 onboarding; M2 carries it to the daemon as the run `cwd`.

## 5. Risks

- HIGH — Cursor headless schema drift. Mitigation: one isolated defensive parser + pinned version (`2025.09.18-7ae6800`) + integration test (`cursor.com/docs/cli/headless`).
- HIGH — Cursor resume session id is unconfirmed and version-volatile. The `--resume [chatId]` flag exists, but the NDJSON field carrying the id is not contract-stable. Mitigation: defensive multi-field extraction (`session_id`|`chatId`|`chat_id`); degrade to a fresh conversation if no id is emitted; pin the version.
- MEDIUM — headless full write access. Mitigation: pass explicit approval flags; scope to the user-chosen `cwd` (plumbed per step-7); the daemon validates the path and never spawns in its own cwd.
- MEDIUM — orphaned CLI grandchildren on daemon shutdown (the M1 path only removes the pidfile; the UI `SIGKILL` escalation bypasses Nest hooks). Mitigation: process registry + kill-children on shutdown/cancel (step-8).
- LOW — partial-line NDJSON across stdout chunks. Mitigation: the buffered defensive parser (a known parser obligation, unit-tested).

## 6. Steps

- [ ] 1. Define `Executor` + event model + tool/event types in `apps/daemon` (mirror `inner/executor.py:96-260,518-596`); expand `ItemKind` from 6 → the normalized 11-kind taxonomy (additive). <!-- step-1 -->
- [ ] 2. Claude headless adapter: spawn `claude -p --output-format stream-json --verbose --input-format stream-json`; buffered defensive NDJSON parse (ignore unknown types); auth via `ANTHROPIC_API_KEY`/subscription; model + `--resume`; capture `session_id` → `node_state.agentSessionId` (`code.claude.com/docs/en/headless`). <!-- step-2 -->
- [ ] 3. Cursor headless adapter: spawn `cursor-agent -p --output-format stream-json`; one isolated defensive version-tolerant NDJSON parser; auth via `CURSOR_API_KEY`; `--force`/approval flags; spawn non-TTY and fail fast if unauthenticated; capture session id defensively (`session_id`|`chatId`|`chat_id`), degrade to fresh start if absent (`cursor.com/docs/cli/headless`). <!-- step-3 -->
- [ ] 4. Persist normalized items + node_state to SQLite with **persist-then-emit** ordering (allocate `seq`, write, then publish); in-proc pub-sub (RxJS Subject) → per-run WS room; add a run-history read (items ≤ `seq`); reconnect = replay history then attach to live filtered to `seq` > last replayed (`session_stream.py:1-108`, `conversation.py:584-610`). <!-- step-4 -->
- [ ] 5. Chats page (single agent): full-screen dialog, streamed transcript, reconnect-to-run via history-replay-then-attach. <!-- step-5 -->
- [ ] 6. Unit tests for each adapter's NDJSON parser (fixtures incl. split-chunk + unknown event types); Cursor integration test pinned to version `2025.09.18-7ae6800` (deferred to the `*.int.ts` placeholder per CLAUDE.md). <!-- step-6 -->
- [ ] 7. Plumb the per-run `cwd` (UI `projectFolder` → daemon over loopback → validated `Run.cwd` → spawn `cwd`); never spawn in the daemon's own cwd. <!-- step-7 -->
- [ ] 8. Child-process registry + kill-children on `OnApplicationShutdown` and run-cancel. <!-- step-8 -->

## 7. Tools Required

- `claude`, `cursor-agent` on PATH; `js-yaml`/`zod` for config; `nestjs-zod` for HTTP input DTOs (per CLAUDE.md); the M1 daemon + SQLite.

## 8. Approval Points

- Before pinning the tested `cursor-agent` version — **pin `2025.09.18-7ae6800`** (the installed version; live capture unavailable here as cursor-agent is unauthenticated in this environment). <!-- step-3 -->
- Demo checkpoint at M2 end.

## 9. Validation

- Chat with Claude and with Cursor end-to-end through the app; messages persist in SQLite; restart the window and reconnect to the same conversation. verify: pnpm --filter daemon test
- Reconnect replay: after a turn, a freshly-connecting client receives the full transcript from history then live events with no gap or duplicate (seq-ordered).
- cwd scope: a spawned agent's working directory is the user's chosen project folder, not the app repo root.
- No orphans: spawned CLI processes are terminated on daemon shutdown and on run-cancel.

## 10. Rollback-Recovery

- `git revert` the M2 branch; adapters are additive over M1.

## 11. Done Condition

- A user can hold a full, persisted, resumable single-agent conversation with both Claude and Cursor entirely through the app, with output normalized to the shared event model, the agent scoped to the user's chosen project folder, and a window restart cleanly reconnecting to an in-flight or completed run.
