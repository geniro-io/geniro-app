---
tier: T1.5
producer: plan
schema-version: 1
branch: claude/claude-cursor-feature-support-5d3ip1
timestamp: 2026-07-22T23:44:23Z
geniro_kind: design-doc
geniro_schema_version: m5-v2
task_slug: native-parity-gaps
topic: Milestone 2 — model and context controls
mode: IDEA
effort_tier: small
lifecycle: draft
parent_spec: native-parity-gaps
budget:
  max_files_to_edit: 15
  max_lines_changed: null
  time_budget: null
checkpoints:
  - step_anchor: step-4
    name: "Compact probe verdict recorded"
forbidden_actions: []
approval_required_for: []
tools_required: ["pnpm", "claude CLI", "cursor-agent CLI"]
---

<!-- geniro:design-doc -->

# Milestone 2 — Model and context controls

## 1. Objective

Expose model selection at chat creation and between turns, add the cursor auto model alias, and give claude chats a context meter with a probe-gated Compact action.

## 2. Scope — Included

- Chats.tsx passes model on create (createChat call, Chats.tsx:605-606); ModelSelect promoted from graphs/ to components/ (model-select.tsx symbol ModelSelect) with a CLI-default empty option and a chip variant; auto added to the cursor alias list (node-schema.ts symbol AGENT_MODEL_OPTIONS).
- PATCH /v1/chats/:runId/settings extends to model (milestone-1 route; run.model re-read per turn already at chat.service.ts symbol sendMessage, so no service change).
- Chat header (chat-header.tsx): Model chip, ContextMeter (last turn_complete usage.contextTokens; agents-panel thresholds), Compact ghost button.
- Compact: probe whether a headless /compact prompt turn works on the installed CLI (agent-version cache pattern); when supported, a Compact turn posts a note item and refreshes the meter; hidden otherwise via GET /v1/capabilities.

## 3. Scope — Excluded

- Any model alias curation beyond adding auto; workflow-run headers (meter is 1:1 claude chats only); thinking-budget controls.

## 4. Assumptions

- Model switch between turns is safe: claude --resume with a different --model continues the session; cursor equivalently (both already re-read run.model each turn).
- Context-window size for the meter derives from the model alias table with a conservative default when unknown.

## 5. Risks

- (medium) Headless /compact unsupported — button hidden by probe, meter still ships alone.
- (low) model-select auto-adopt-first-alias behavior conflicts with CLI-default semantics — the promoted variant makes the empty option first-class (model-select.tsx symbol ModelSelect, auto-adopt effect).

## 6. Steps

- [ ] 1. Promote model-select to components/ with CLI-default + chip variant; add auto to AGENT_MODEL_OPTIONS cursor list (model-select.tsx; node-schema.ts symbol AGENT_MODEL_OPTIONS). <!-- step-1 -->
- [ ] 2. New-chat card wires agentKind-aware ModelSelect and sends model on create (Chats.tsx symbol startChat/createChat call site). <!-- step-2 -->
- [ ] 3. Extend PATCH /settings with model; header Model chip switches it between turns (chat.controller.ts settings route from milestone 1; chat-header.tsx). <!-- step-3 -->
- [ ] 4. Compact probe spike (child-handle + agent-version cache) exposed via capabilities (cursor-probe.service.ts pattern, symbol CursorProbeService). <!-- step-4 -->
- [ ] 5. ContextMeter component + Compact action wiring in the header (chat-header.tsx; usage from the latest turn_complete item payload, event-to-item.ts symbol mapEventToItem). <!-- step-5 -->
- [ ] 6. Co-located specs: model-select variant, settings PATCH, meter thresholds, compact service path. <!-- step-6 -->

## 7. Tools Required

- pnpm scripts; installed claude CLI (compact probe) and cursor-agent CLI (auto alias sanity).

## 8. Approval Points

- none — runs autonomously start-to-finish.

## 9. Validation

Unit specs per step-6; seams: PATCH /v1/chats/:runId/settings, ModelSelect component contract, capabilities endpoint.
verify: pnpm --filter @geniro/ui test:unit
Manual: create a cursor chat on auto; switch a claude chat fable→haiku between turns and see the next turn use it; meter percentage moves after a long turn; Compact drops it (or the button is absent when unsupported).

## 10. Rollback-Recovery

none — pure additive UI + one DTO field; git revert restores prior behavior; run.model semantics unchanged.

## 11. Done Condition

Unit tests green for @geniro/ui and @geniro/daemon AND the manual model-switch and meter/Compact demos verified.
