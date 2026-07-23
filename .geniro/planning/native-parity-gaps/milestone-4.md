---
tier: T1.5
producer: plan
schema-version: 1
branch: claude/claude-cursor-feature-support-5d3ip1
timestamp: 2026-07-22T23:45:24Z
geniro_kind: design-doc
geniro_schema_version: m5-v2
task_slug: native-parity-gaps
topic: Milestone 4 — cursor parity and per-node MCP toggle
mode: IDEA
effort_tier: medium
lifecycle: draft
parent_spec: native-parity-gaps
budget:
  max_files_to_edit: 18
  max_lines_changed: null
  time_budget: null
checkpoints:
  - step_anchor: step-1
    name: "PTY credential scoping fixed before any cursor mirror code"
  - step_anchor: step-5
    name: "useProjectMcp semantics approved and landed"
forbidden_actions:
  - "do NOT ship the cursor mirror before the PTY env scoping fix — claude credentials must never reach a cursor child"
  - "do NOT relax --strict-mcp-config outside the explicit per-node toggle; auto-mode nodes with the toggle on must surface a builder warning"
approval_required_for:
  - step-5
tools_required: ["pnpm", "cursor-agent CLI"]
---

<!-- geniro:design-doc -->

# Milestone 4 — Cursor parity and per-node MCP toggle

## 1. Objective

Bring cursor sessions into the terminal mirror behind a version probe, surface cursor built-in slash commands, and add the per-caller-node project-MCP toggle with explicit security guards.

## 2. Scope — Included

- PTY env scoping: terminals.service credential injection becomes per-agent-kind (terminals.service.ts symbol TerminalsService, claudeCredentialEnv call at :135-138) — prerequisite fix.
- terminal-command.ts cursor branch: cursor-agent --resume with the harvested session id behind an agent-version probe; reasoned TERMINAL_UNSUPPORTED otherwise (terminal-command.ts symbol terminalCommand).
- Renderer: terminal action for cursor rows, aria-disabled + tooltip when unsupported (agents-panel.tsx terminal button).
- Cursor built-ins: static documented list merged in skills service for cursor kind, source cli-static (skills.service.ts symbol SkillsService, claude-only gate at :99-108).
- useProjectMcp: agent-node zod field default false (graphs.types.ts symbol AgentNodeSchema), renderer inspector Switch + hint, workflow-yaml AGENT_ONLY_FIELDS mirror (workflow-yaml.ts:54), claude adapter omits --strict-mcp-config when set (claude.adapter.ts symbol buildArgs, :314-319), builder warning when combined with auto approval; the adapter refuses a project .mcp.json that redefines the geniro server key (mirror cursor-mcp-file.ts:160-164) — visible turn failure, never imposter routing of call_agent traffic; new Switch primitive in components/ui/.

## 3. Scope — Excluded

- Cursor approval protocol, cursor attachments (upstream gaps); MCP toggle for non-caller nodes (native behavior already loads project MCP there); disabling cursor's own trust-store entries (accepted M3 limitation stands).

## 4. Assumptions

- cursor-agent TUI resume accepts the harvested id on current versions (step-2 probe; six-key drift list at cursor.adapter.ts:19-26 stays the harvest source).
- The static built-ins list is maintained by hand until cursor exposes introspection; entries carry source cli-static so the UI can label them.

## 5. Risks

- (high) Credential bleed if the mirror lands before step-1 — ordering is a forbidden_action and a checkpoint.
- (medium) cursor --resume drift across versions — probe caches per version; degrade is a reasoned error, never a wrong-session attach.
- (medium) useProjectMcp on an auto node quietly widens the blast radius — builder warning + parent-spec approval point cover the policy; a foreign geniro key in the project config is refused outright.
- (minor) An interactive cursor mirror opened mid-run could load a live merged geniro entry + call token — mirror open is refused during an active merge (step-3).

## 6. Steps

- [ ] 1. Scope PTY credential env by agent kind (terminals.service.ts symbol TerminalsService, :135-138; child-env util claudeCredentialEnv). <!-- step-1 -->
- [ ] 2. Version probe for cursor resume support cached per binary version (agent-version.ts symbol resolveAgentVersion; cursor-probe.service.ts caching pattern), exposed via capabilities. <!-- step-2 -->
- [ ] 3. terminal-command cursor branch + terminals.service spawn wiring (terminal-command.ts symbol terminalCommand; terminals.service.ts resolve path); refuse opening a cursor mirror while the run cwd holds a live geniro MCP merge (cursor-mcp-merge.service state check). <!-- step-3 -->
- [ ] 4. Renderer terminal affordance for cursor + skills static built-ins merge (agents-panel.tsx; skills.service.ts symbol SkillsService). <!-- step-4 -->
- [ ] 5. useProjectMcp end-to-end: zod field + inspector Switch + YAML mirror + adapter argv change + auto-mode warning (graphs.types.ts symbol AgentNodeSchema; Graphs.tsx inspector; workflow-yaml.ts:54; claude.adapter.ts:314-319). <!-- step-5 -->
- [ ] 6. Switch primitive in components/ui/ (token-driven, cva; components/ui/ house pattern). <!-- step-6 -->
- [ ] 7. Co-located specs: env scoping (spec must fail if cursor child sees claude creds), terminal-command matrix, skills merge, adapter argv with/without toggle, Switch component. <!-- step-7 -->

## 7. Tools Required

- pnpm scripts; installed cursor-agent CLI for the resume probe.

## 8. Approval Points

- step-5 — confirm useProjectMcp warning copy and the auto+MCP policy before landing (mirrors the parent spec approval point).

## 9. Validation

Unit specs per step-7; seams: POST /v1/terminals (mirror open), GET /v1/agents/skills (static merge), adapter buildArgs (toggle), GET /v1/capabilities (probe verdicts).
verify: pnpm --filter @geniro/daemon test:unit
Manual: open a mirror on a cursor session (or observe the reasoned degrade on an unsupported version); type / in a cursor chat and see built-ins; enable the toggle on a caller node and watch its turn reach a project MCP server; auto+toggle shows the builder warning.

## 10. Rollback-Recovery

none — pure additive: probe-gated branches and a default-false node field; git revert removes them; existing YAML without the field stays valid.

## 11. Done Condition

Unit tests green AND the four manual demos verified (mirror or degrade; built-ins visible; toggle reaches project MCP; auto+toggle warning shown).
