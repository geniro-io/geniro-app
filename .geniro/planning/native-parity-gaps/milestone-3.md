---
tier: T1.5
producer: plan
schema-version: 1
branch: claude/claude-cursor-feature-support-5d3ip1
timestamp: 2026-07-22T23:45:24Z
geniro_kind: design-doc
geniro_schema_version: m5-v2
task_slug: native-parity-gaps
topic: Milestone 3 — live streaming and image attachments
mode: IDEA
effort_tier: medium
lifecycle: draft
parent_spec: native-parity-gaps
blocked_by: [1]
budget:
  max_files_to_edit: 22
  max_lines_changed: null
  time_budget: null
checkpoints:
  - step_anchor: step-1
    name: "Probe verdicts recorded — image blocks + partial-messages-with-ask known"
  - step_anchor: step-4
    name: "Delta plane landed with twin specs green"
forbidden_actions:
  - "do NOT persist per-delta item rows — transient WS plane only; exactly ONE partial-text flush item is allowed on turn cancel/error"
  - "do NOT send attachments to cursor-agent — reject with BadRequestException at the DTO/service boundary"
approval_required_for: []
tools_required: ["pnpm", "claude CLI"]
---

<!-- geniro:design-doc -->

# Milestone 3 — Live streaming and image attachments

## 1. Objective

Stream assistant text live via a transient delta plane and let claude chats send image attachments end-to-end.

## 2. Scope — Included

- claude buildArgs gains --include-partial-messages (claude.adapter.ts symbol ClaudeAdapter.buildArgs); mapClaudeMessage handles stream_event text deltas as a new non-persisted AgentEvent (claude.adapter.ts symbol mapClaudeMessage, default branch).
- Transient delta plane: event bus + notifications gateway emit without persist (agent-events.bus.ts symbol AgentEventsBus; notifications.gateway.ts bus subscription), renderer merge into a live bubble (Chats.tsx transcript state; daemon-client.ts) — reciprocal TWIN PARSER blocks on both sides.
- Transport: a backward-compatible fastifyOptions/bodyLimit passthrough on the vendored @packages/http-server (FastifyAdapter at packages/http-server/src/setup.ts:329; wired from apps/daemon/src/main.ts:50-82), sized to the attachment caps — Fastify's default 1 MiB otherwise 413s an image post before the DTO runs.
- Attachments: SendMessageDto gains attachments (base64+mime, zod caps: 10 files, png/jpeg/gif/webp); AgentTurnInput carries structured content additively (adapter.types.ts symbol AgentTurnInput.prompt stays string; new optional attachments field); claude buildStdinPayload emits image blocks (claude.adapter.ts symbol buildStdinPayload); cursor service path rejects attachments.
- User message item payload stores attachment metadata + data; transcript thumbnails replace the null render (transcript-item.tsx attachment case, symbol TranscriptItem); composer paperclip + paste + AttachmentChips; Electron IPC image picker following the extension-filtered dialog pattern (ipc.ts symbol registerIpc, showOpenDialog usage).

## 3. Scope — Excluded

- Cursor attachments (no headless channel); delta persistence; lightbox; reasoning-delta streaming (text only in v1).

## 4. Assumptions

- Blocked by milestone 1 only for the ask-mode interplay probe (stdio control protocol + partial messages on one stream).
- Base64 payloads inside the items text column are acceptable at the 10-file/5MB-soft caps; no separate blob store.

## 5. Risks

- (high) Probe failure on image blocks — feature hidden via capabilities; composer paperclip absent, DTO still validates (server rejects when unsupported).
- (medium) Delta flood into the persist path by future mistake — forbidden_actions + a spec asserting mapEventToItem returns null for deltas (event-to-item.ts symbol mapEventToItem).
- (medium) Twin drift between gateway delta emit and daemon-client parse — reciprocal TWIN PARSER blocks + paired specs.

## 6. Steps

- [ ] 1. Probe spike: stream-json image content blocks AND --include-partial-messages under --permission-prompt-tool stdio on installed claude; cache per version; expose via capabilities (agent-version.ts symbol resolveAgentVersion; cursor-probe.service.ts pattern). <!-- step-1 -->
- [ ] 2. Adapter: add the flag; map stream_event text deltas to a new text_delta AgentEvent; mapEventToItem returns null for it (claude.adapter.ts symbol mapClaudeMessage; event-to-item.ts symbol mapEventToItem). <!-- step-2 -->
- [ ] 3. Bus + gateway transient emit with TWIN PARSER block (agent-events.bus.ts symbol AgentEventsBus.publish; notifications.gateway.ts bus fan-out). <!-- step-3 -->
- [ ] 4. Renderer delta merge: daemon-client twin parser + live bubble state keyed by run, replaced in place by the persisted item (daemon-client.ts symbol DaemonClient; Chats.tsx transcript reducer); on turn cancel/error the daemon flushes its delta buffer as ONE partial-flagged message item so afterSeq replay matches what was watched (item.dao.ts afterSeq contract). <!-- step-4 -->
- [ ] 5. Raise the daemon body limit via the http-server passthrough (packages/http-server/src/setup.ts:329; apps/daemon/src/main.ts:50-82) sized to the caps, then attachments daemon path: SendMessageDto attachments; chat.service validates kind (cursor rejects); item payload carries attachments; claude buildStdinPayload emits image blocks (chat.dto.ts symbol sendMessageSchema; chat.service.ts symbol sendMessage; claude.adapter.ts symbol buildStdinPayload). <!-- step-5 -->
- [ ] 6. Renderer attachments: IPC image picker, paperclip + paste handling, AttachmentChips, transcript thumbnails (ipc.ts symbol registerIpc; composer-card.tsx; transcript-item.tsx symbol TranscriptItem). <!-- step-6 -->
- [ ] 7. Co-located specs incl. delta-null persistence pin, twin pairs, DTO caps, cursor rejection path. <!-- step-7 -->

## 7. Tools Required

- pnpm scripts; installed claude CLI for the step-1 probes.

## 8. Approval Points

- none — runs autonomously start-to-finish.

## 9. Validation

Unit specs per step-7; seams: POST /v1/chats/:runId/messages (attachments), WS delta event (gateway↔client twins), buildStdinPayload (adapter).
verify: pnpm test:unit
Manual: watch text grow token-by-token with no layout jump and identical final transcript after reload; paste a screenshot, send, and get an answer about its content; verify a cursor chat rejects attachments with a clear error.

## 10. Rollback-Recovery

Delta plane rides the argv flag — removing --include-partial-messages restores block streaming with zero data impact; attachments are additive DTO/payload fields; git revert per feature commit.

## 11. Done Condition

Unit tests green across workspaces AND both manual demos verified (live streaming; image round-trip) or the corresponding probe recorded as unsupported with the feature hidden.
