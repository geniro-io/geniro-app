---
tier: T1.5
producer: plan
schema-version: 1
branch: claude/claude-cursor-feature-support-5d3ip1
timestamp: 2026-07-22T23:43:18Z
geniro_kind: design-doc
geniro_schema_version: m5-v2
task_slug: native-parity-gaps
topic: Close the functional parity gaps between geniro-app and the native Claude Code / Cursor apps
mode: IDEA
effort_tier: big
lifecycle: approved
budget:
  max_files_to_edit: 70
  max_lines_changed: null
  time_budget: null
checkpoints:
  - step_anchor: step-1
    name: "Milestone 1 landed — chat approvals + permission modes green"
  - step_anchor: step-3
    name: "Milestone 3 landed — streaming + images green"
forbidden_actions:
  - "do NOT put call tokens, API keys, or any secret on argv — tokens ride 0600 files or stdin only"
  - "do NOT let claude credentials reach cursor-agent children (or vice versa) — per-child env re-injection only"
  - "do NOT drop --strict-mcp-config by default — only the explicit per-node useProjectMcp toggle may omit it"
  - "do NOT store secrets outside the macOS Keychain"
  - "do NOT persist per-delta item rows — the block item is the durable record; exactly ONE partial-text flush item is allowed when a turn cancels or fails mid-stream"
  - "do NOT trust a project .mcp.json that redefines the geniro server name — a useProjectMcp turn must refuse the collision visibly (mirror cursor-mcp-file.ts:160-164)"
approval_required_for:
  - step-4
tools_required: ["pnpm", "node>=24", "claude CLI", "cursor-agent CLI"]
---

<!-- geniro:design-doc -->

# Native parity gaps — Claude Code / Cursor

## 1. Objective

Close the functional parity gaps between geniro-app and the native Claude Code and Cursor apps across chat approvals, permission modes, model selection, image input, live streaming, context compaction, per-node MCP access, and cursor terminal mirroring.

## 2. Scope — Included

- Chat tool-approval plane: per-run approval setting (new run column, default ask), the 4 chat.service seams (apps/daemon/src/v1/agents/services/chat.service.ts:243, :47-57, :247-277, :282-319), ApprovalModeSelect UI.
- Permission-mode extension ask|acceptEdits|plan|auto across apps/daemon/src/v1/agents/adapters/adapter.types.ts:109, both adapters, graphs.types.ts:92-98, and the three executor seams (apps/daemon/src/v1/graphs/services/graph-executor.service.ts:806, :877, :575). plan is chat-only, probe-gated.
- Chat model picker (create + PATCH settings + header chip), promoted model-select (apps/ui/src/renderer/graphs/model-select.tsx), cursor alias list gains auto (apps/ui/src/renderer/graphs/node-schema.ts:90-93).
- Image attachments for claude chats: SendMessageDto attachments, claude stdin image blocks (apps/daemon/src/v1/agents/adapters/claude/claude.adapter.ts:341-349), composer paperclip/paste/chips, transcript thumbnails (apps/ui/src/renderer/chats/transcript-item.tsx:269).
- Live streaming: --include-partial-messages + transient (non-persisted) WS delta plane (twin parsers) + live-growing assistant bubble.
- Context meter + probe-gated Compact action for claude chats.
- Per-caller-node "Use project MCP" toggle (claude.adapter.ts:314-319) with auto-mode security warning; Switch primitive.
- Cursor terminal mirror behind a version probe, preceded by the PTY credential-scoping fix (apps/daemon/src/v1/terminals/services/terminals.service.ts:135-138); static cursor built-in slash-command list in skills merge (apps/daemon/src/v1/agents/services/skills.service.ts:99-108).

## 3. Scope — Excluded

- Checkpoints/rewind, /compact-style context editing beyond the single Compact action, --add-dir multi-workspace turns, thinking-budget controls (headless protocol gaps; deliberate).
- Image input for cursor chats (no documented headless image channel) — paperclip stays visibly disabled.
- An approval (ask) protocol for cursor turns — upstream CLI limitation; degrade stays visible, now for every non-auto mode.
- Project-MCP toggle for non-caller nodes — those turns already load project MCP natively (no --mcp-config is passed).
- Image lightbox/preview, delta persistence, message-queue changes (queueing already exists — apps/ui/src/renderer/chats/Chats.tsx:781-808).

## 4. Assumptions

- Approval-mode selector lives in the composer chip row; plan option is hidden (not disabled) when the probe fails; cursor-disabled controls render aria-disabled with tooltip, never native disabled.
- Attachments: png/jpeg/gif/webp, soft cap 10 per message, base64 in item payload; thumbnails static in v1.
- Context meter renders in 1:1 claude chats only; thresholds mirror the agents-panel (70/90).
- Headless claude honors --permission-mode acceptEdits and plan together with --permission-prompt-tool stdio (probe in milestone 1 confirms; plan hidden on failure).
- claude -p accepts stream-json image content blocks on stdin (probe in milestone 3; feature hidden on failure).
- --include-partial-messages coexists with the stdio control protocol (probe in milestone 3).
- cursor-agent TUI resume works for harvested session ids on current versions (probe in milestone 4; mirror degrades to a reasoned error otherwise).
- A static list of documented cursor built-in slash commands is acceptable until cursor exposes introspection.
- Message queueing needs no work — verified already implemented client-side.
- The daemon HTTP body limit is raised via a backward-compatible fastifyOptions/bodyLimit option on the vendored @packages/http-server (defaults preserved, upstreamable), sized to the attachment caps.
- acceptEdits degrades VISIBLY to ask (persisted system item + builder warning) when its probe fails; plan is hidden; no degrade is ever silent.

## 5. Risks

- (high) Executor seam regression: extending the mode union can silently auto-approve plan/acceptEdits graph nodes (graph-executor.service.ts:877) or skip the cursor degrade warning (:575). Mitigation: milestone 1 rewrites all three seams with dedicated specs entering each branch.
- (high) Credential bleed in PTY mirror: terminals.service.ts:135-138 injects claude credentials into every session. Mitigation: milestone 4 step 1 scopes env by agent kind before the cursor branch lands.
- (medium) CLI behavior drift on the four probed features. Mitigation: each milestone opens with its probe; failure hides the feature via GET /v1/capabilities, never silently.
- (medium) Twin-parser drift: deltas + attachments add daemon↔renderer wire shapes. Mitigation: reciprocal TWIN PARSER doc blocks + paired specs, per house rule.
- (low) Transient deltas lost on reconnect mid-turn — superseded by the persisted block item by design; a cancelled/failed turn flushes ONE partial-flagged message item so replay matches what was watched.
- (high) Fastify default 1 MiB bodyLimit rejects base64 image posts before validation (packages/http-server/src/setup.ts:329; apps/daemon/src/main.ts:50-82 passes no fastifyOptions). Mitigation: milestone 3 adds a backward-compatible bodyLimit passthrough to the vendored http-server, sized to the attachment caps.
- (medium) Reverting milestone 1 must NOT narrow ApprovalModeSchema back — workflow-store silently drops YAML that fails parsing (workflow-store.service.ts:123-131); the enum widening is a one-way door kept on rollback.
- (low) Probe verdicts can go stale after a mid-session CLI upgrade — every probe verdict re-validates against the current --version at turn/run start (cursor-probe precedent, cursor-probe.service.ts:139-157).

## 6. Steps

- [ ] 1. Milestone 1 — Chat permission plane: approval modes end-to-end (chat.service.ts:243, adapter.types.ts:109, graph-executor.service.ts:806). <!-- step-1 -->
- [ ] 2. Milestone 2 — Model and context controls (Chats.tsx:606, chat.service.ts:200, node-schema.ts:90-93). <!-- step-2 -->
- [ ] 3. Milestone 3 — Live streaming and image attachments (claude.adapter.ts:290-321, :341-349, event-to-item.ts:19-24). <!-- step-3 -->
- [ ] 4. Milestone 4 — Cursor parity and per-node MCP toggle (terminal-command.ts:17-33, terminals.service.ts:135-138, claude.adapter.ts:314-319). <!-- step-4 -->

## 7. Tools Required

- pnpm (workspace scripts; full-check gate), node >= 24 + Electron ABI via pnpm rebuild:native.
- Installed claude CLI and cursor-agent CLI for the four probes; macOS Keychain for the cursor key.

## 8. Approval Points

- step-4 before landing the useProjectMcp semantics: relaxing --strict-mcp-config interacts with auto-mode nodes — confirm the warning copy and the auto+MCP combination policy.

## 9. Validation

Unit (vitest, co-located): adapter buildArgs matrices for every mode/flag combination (claude.adapter.spec.ts pattern); chat.service approval track/sweep incl. the early-return finalizer path; executor seam specs that ENTER the rewritten branches (:806/:877/:575); gateway + daemon-client twin specs for delta and attachment wire shapes; terminal-command cursor branch; skills merge with the static cursor list; model-select CLI-default variant.
verify: pnpm check-types
verify: pnpm test:unit
Manual per milestone: approval card round-trip in a plain chat; model switch between turns; live token streaming + an image answered about by the agent; cursor mirror attach or its reasoned degrade.

## 10. Rollback-Recovery

Pure additive schema changes (new nullable run column; new item payload fields) — safe:true sync never drops them; revert is per-milestone git revert of the feature commits, UI controls disappear with the revert, and the delta plane rides adapter argv so removing the flag restores block streaming. One one-way door: the widened ApprovalModeSchema stays widened on any revert — narrowing it makes workflow-store silently drop saved YAML carrying acceptEdits (workflow-store.service.ts:123-131); rollback removes behavior, never the tolerant parse. No data migration needed.

## 11. Done Condition

pnpm full-check green AND all four milestone demo criteria verified manually AND each of the four CLI probes either confirmed or its feature observably hidden/degraded in the UI.

## Considered Alternatives

### TurnOptions refactor first (rejected)
Unified per-run settings abstraction. Stress-test: BLOCKING (verified) — graph approvalMode is computed per-turn over node YAML (graph-executor.service.ts:797-806); run-level read-through mis-modes every graph turn; strands run.model under additive-only sync.
Why not recommended: verified blocking risk at graph-executor.service.ts:797-806.

### Big-bang single integration (rejected)
All features in one branch. Stress-test: BLOCKING (verified) — cursor TUI resume unknown gates the branch (terminal-command.ts:30-33); serialized rewrites of one seam (adapter.types.ts:109); 7/8 features co-touch Chats.tsx.
Why not recommended: two verified blocking risks; house delivery is milestone-sliced.

## Milestones

| # | File | Blocked by | Demo |
|---|---|---|---|
| 1 | milestone-1.md | — | plain chat asks, acceptEdits/plan modes work |
| 2 | milestone-2.md | — | model switch between turns; context meter + Compact |
| 3 | milestone-3.md | 1 | live token streaming; image sent and understood |
| 4 | milestone-4.md | — | cursor mirror opens (or reasoned degrade); MCP toggle |
