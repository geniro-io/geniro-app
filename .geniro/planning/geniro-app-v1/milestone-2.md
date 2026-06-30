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

# geniro v1 · Milestone 2 — One agent in chat (headless)

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Define the unified agent-adapter contract and drive Claude and Cursor headlessly, exposing a full-screen single-agent chat with persisted, resumable history.

## 2. Scope — Included

- `Executor` interface + normalized event model (TextChunk/ReasoningChunk/ToolCallRequest/ToolCallComplete/TurnComplete/TurnCancelled/Error) ported in spirit from `inner/executor.py:518-596` and the wire `session.*`/`response.*` shapes (`schemas.py:3681-3739`).
- Claude headless adapter: spawn `claude -p --output-format stream-json --input-format stream-json`, parse NDJSON → events; auth via `ANTHROPIC_API_KEY`/subscription; model + `--resume` (`code.claude.com/docs/en/headless`).
- Cursor headless adapter: spawn `cursor-agent -p --output-format stream-json`, defensive version-tolerant NDJSON parser; auth via `CURSOR_API_KEY`; `--force`/`--approve-mcps` handling (`cursor.com/docs/cli/headless`).
- Persistence: write conversation `items` (normalized 11-kind taxonomy, `conversation.py:584-610`) + `node_state` (CLI session id for resume) to SQLite; in-proc pub-sub bus streaming to the renderer (`session_stream.py:1-108`).
- Chats page (single agent): full-screen dialog, send messages, stream rendered transcript, reconnect to an in-flight run after window restart.

## 3. Scope — Excluded

- No graph/DAG yet (M3) — this is a single agent, not a team.
- No PTY terminal/auto-update/packaging (M4).

## 4. Assumptions

- The CLIs accept the documented headless flags and emit a parseable NDJSON stream with usage.
- Claude `stream-json` stable; Cursor schema pinned to a tested version.

## 5. Risks

- HIGH — Cursor headless schema drift. Mitigation: one isolated defensive parser + pinned version + integration test (`cursor.com/docs/cli/headless`).
- MEDIUM — headless full write access. Mitigation: pass explicit approval flags; scope to the chosen cwd.

## 6. Steps

- [ ] 1. Define `Executor` + event model + tool/event types in `apps/daemon` (mirror `inner/executor.py:96-260,518-596`). <!-- step-1 -->
- [ ] 2. Claude headless adapter: spawn + NDJSON parse + auth + model/resume (`code.claude.com/docs/en/headless`). <!-- step-2 -->
- [ ] 3. Cursor headless adapter: spawn + defensive NDJSON parser + `CURSOR_API_KEY` + approval flags (`cursor.com/docs/cli/headless`). <!-- step-3 -->
- [ ] 4. Persist normalized items + node_state to SQLite; in-proc pub-sub → WS to renderer (`session_stream.py:1-108`, `conversation.py:584-610`). <!-- step-4 -->
- [ ] 5. Chats page (single agent): full-screen dialog, streamed transcript, reconnect-to-run. <!-- step-5 -->
- [ ] 6. Unit tests for each adapter's NDJSON parser; Cursor integration test pinned to a version. <!-- step-6 -->

## 7. Tools Required

- `claude`, `cursor-agent` on PATH; `js-yaml`/`zod` for config; the M1 daemon + SQLite.

## 8. Approval Points

- Before pinning the tested `cursor-agent` version. <!-- step-3 -->
- Demo checkpoint at M2 end.

## 9. Validation

- Chat with Claude and with Cursor end-to-end through the app; messages persist in SQLite; restart the window and reconnect to the same conversation. verify: pnpm --filter daemon test

## 10. Rollback-Recovery

- `git revert` the M2 branch; adapters are additive over M1.

## 11. Done Condition

- A user can hold a full, persisted, resumable single-agent conversation with both Claude and Cursor entirely through the app, with output normalized to the shared event model.
