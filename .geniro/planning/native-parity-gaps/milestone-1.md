---
tier: T1.5
producer: plan
schema-version: 1
branch: claude/claude-cursor-feature-support-5d3ip1
timestamp: 2026-07-22T23:44:23Z
geniro_kind: design-doc
geniro_schema_version: m5-v2
task_slug: native-parity-gaps
topic: Milestone 1 — chat permission plane (approval modes end-to-end)
mode: IDEA
effort_tier: medium
lifecycle: draft
parent_spec: native-parity-gaps
budget:
  max_files_to_edit: 25
  max_lines_changed: null
  time_budget: null
checkpoints:
  - step_anchor: step-2
    name: "Probe verdict recorded — plan/acceptEdits headless behavior known"
  - step_anchor: step-6
    name: "chat.service seams landed, unit specs green"
forbidden_actions:
  - "do NOT auto-approve permission requests for plan or acceptEdits graph nodes — only questionCapable auto nodes keep the daemon auto-approve"
  - "do NOT let the cursor degrade warning key on ask alone — any non-auto mode must warn"
approval_required_for: []
tools_required: ["pnpm", "claude CLI"]
---

<!-- geniro:design-doc -->

# Milestone 1 — Chat permission plane

## 1. Objective

Make plain chats approval-capable and extend the permission-mode set to ask, acceptEdits, plan (chat-only), and auto everywhere an approval mode exists.

## 2. Scope — Included

- adapter.types.ts:109 (AgentTurnInput.approvalMode) union extension; claude buildArgs mapping (claude.adapter.ts:290-321) and keepStdinOpen (claude.adapter.ts:351-352) for the new modes.
- Headless probe for acceptEdits/plan with --permission-prompt-tool stdio; capabilities exposure via GET /v1/capabilities (capabilities.controller in apps/daemon/src/v1/graphs/controllers/).
- graphs.types.ts:92-98 ApprovalModeSchema gains acceptEdits; renderer mirrors (node-schema.ts, workflow-yaml.ts:54 AGENT_ONLY_FIELDS).
- The three executor seams: graph-executor.service.ts:806 (effective-mode computation), :877 (auto-approve guard), :575 (cursor degrade warning for any non-auto mode).
- Run row gains approval column (apps/daemon/src/v1/runs/entity/run.entity.ts, nullable text, additive); CreateChatDto + new PATCH /v1/chats/:runId/settings (beside chat.controller.ts:39-45 rename); contracts.ts mirror.
- chat.service.ts 4 seams: approvalMode passthrough (:243), ApprovalRegistry injection (:47-57), approvals.track mirror of graph-executor.service.ts:897-937 with nodeId SINGLE_AGENT_NODE (:247-277), sweepNode in the finalizer respecting the early return (:282-319, :301).
- ApprovalModeSelect chip component (apps/ui/src/renderer/chats/), cursor chats pinned to auto with hint, disabled mid-turn.

## 3. Scope — Excluded

- plan mode for graph nodes (chat-only by decision); model/attachments/streaming (milestones 2-3); any cursor approval protocol (upstream limitation).

## 4. Assumptions

- Existing YAML workflows with approval auto/ask keep validating after the zod union widens (verified by critic: default('auto') is back-compatible).
- ApprovalCard, WS verdict round-trip, and expiredApprovalIds already handle chat-shaped items (nodeId null) — renderer reuse as-is (approval-card.tsx, transcript-item.tsx:278-331).

## 5. Risks

- (high) Seam :877 mis-rewrite silently auto-approves everything for new modes — spec must enter the branch per .claude/rules/testing.md.
- (medium) plan probe fails on installed CLI — option hidden via capabilities; no dead UI.
- (low) PATCH settings route colliding with rename PATCH — separate subpath /settings keeps the rename contract untouched.
- (medium) Reverting the enum widening silently drops saved workflows (workflow-store.service.ts:123-131) — rollback keeps the widened schema (one-way door).

## 6. Steps

- [ ] 1. Extend AgentTurnInput.approvalMode union and claude buildArgs/keepStdinOpen mapping (adapter.types.ts:109; claude.adapter.ts:290-321, :351-352); cursor adapter maps every non-auto mode to its visible degrade (cursor.adapter.ts:234-244). <!-- step-1 -->
- [ ] 2. Probe spike: drive installed claude with acceptEdits and plan under --permission-prompt-tool stdio via a registered short-lived child (utils/child-handle.ts, utils/agent-version.ts); cache verdict per version, re-validated against the current --version at each turn start (cursor-probe.service.ts:139-157 precedent); acceptEdits probe-failure degrades visibly to ask (persisted system item + builder warning), plan hidden; expose in GET /v1/capabilities. <!-- step-2 -->
- [ ] 3. Widen ApprovalModeSchema with acceptEdits (graphs.types.ts:92-98) + renderer mirrors (node-schema.ts approval options; workflow-yaml.ts:54). <!-- step-3 -->
- [ ] 4. Rewrite the three executor seams for the widened union: effective-mode computation (graph-executor.service.ts:806), auto-approve guard limited to questionCapable auto nodes (:877), cursor warning for any non-auto mode (:575). <!-- step-4 -->
- [ ] 5. Run row approval column + CreateChatDto.approval + PATCH /v1/chats/:runId/settings + contracts.ts mirror (run.entity.ts; chat.dto.ts:10-16; chat.controller.ts:39-45 pattern); PATCH /settings returns 409 RUN_BUSY while a turn is in flight — daemon-side contract matching the disabled UI. <!-- step-5 -->
- [ ] 6. chat.service seams: pass approvalMode from the run row (:243), inject ApprovalRegistry (:47-57), track approvals with persisted approval_verdict items (:247-277 mirroring graph-executor.service.ts:897-937), sweepNode in the finalizer without bypassing the :301 early return. <!-- step-6 -->
- [ ] 7. ApprovalModeSelect chip in new-chat card + open-chat composer (Chats.tsx:605-606 area; composer-card.tsx children); cursor pinned auto with tooltip; plan hidden when capabilities says unsupported. <!-- step-7 -->
- [ ] 8. Co-located specs: buildArgs matrix, executor seam-entering specs, chat.service track/sweep incl. early-return path, selector component spec (jsdom line 1). <!-- step-8 -->

## 7. Tools Required

- pnpm scripts; installed claude CLI for the step-2 probe.

## 8. Approval Points

- none — runs autonomously; the parent spec gates milestone 4, not this one.

## 9. Validation

Unit specs listed in step-8; the executor seam specs MUST fail if the :877 guard reverts to the binary worldview (test enters the acceptEdits/plan branches). Seams: POST /v1/chats + PATCH /settings (route), adapter.start input (service), buildArgs (adapter).
verify: pnpm --filter @geniro/daemon test:unit
Manual: plain claude chat asks via card for an Edit; acceptEdits chat edits without a card but asks for Bash; plan chat produces a plan and stops.

## 10. Rollback-Recovery

Additive column + argv mapping — git revert of the milestone commits; existing chats (approval null) keep today's exact behavior because null maps to the legacy no-flags argv. Exception: the widened ApprovalModeSchema stays widened on revert — narrowing silently drops saved YAML carrying acceptEdits (workflow-store.service.ts:123-131).

## 11. Done Condition

Unit tests green (pnpm --filter @geniro/daemon test:unit and @geniro/ui) AND the three manual mode demos verified in a real chat.
