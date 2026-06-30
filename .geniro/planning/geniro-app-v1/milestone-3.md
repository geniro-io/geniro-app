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

# geniro v1 · Milestone 3 — Graph + execution

> Reference sources for the `file:line` citations below (read-only, for grounding — NOT files in this repo):
> Geniro monorepo at `/Users/sergeirazumovskij/Desktop/Projects/Geniro/geniro`; Omnigent clone analyzed in research; full analysis at `docs/research/geniro-vs-omnigent-analysis.md`.


## 1. Objective

Port the Geniro graph engine to standalone TypeScript, add a canvas editor backed by YAML, and execute a DAG of agents as a team with the chosen approval model.

## 2. Scope — Included

- Port Geniro core to TS: `{nodes,edges}` schema + validation + Kahn topo-sort + registry (`graph-compiler.ts:40-233,582-645`, `graphs.types.ts:11-20`, `graph-registry.ts:19-294`), de-coupled from NestJS DI (explicit factory map, no DiscoveryService).
- Workflow YAML: load/save `*.geniro.yaml` (central library + import/export) with a `layout` block for canvas positions; zod validation.
- Workflows page: canvas editor (port Geniro React Flow + elkjs) to build nodes+edges; static build (no live-run animation).
- DAG fan-out executor in the daemon: walk topo order, run independent nodes in parallel, sequential chains; node = {agent, model, shared cwd, role/system-prompt, approval flags, opt MCP}; edge = node A's final text → node B's prompt context + shared folder.
- Approval model: auto-approve default + per-node "ask in UI" → elicitation cards in the renderer; verdict returned to the adapter.
- Chats page runs a chosen workflow: full-screen dialog drives the graph; per-node rendered transcripts.

## 3. Scope — Excluded

- No live real-time canvas animation (deferred).
- No conditional routing / fan-in-join / loops.
- No PTY terminal/auto-update/packaging (M4).

## 4. Assumptions

- The Geniro core ports cleanly (Phase 1 confirmed).
- A single shared working folder (cwd) per run is acceptable for v1 (no worktrees).

## 5. Risks

- MEDIUM — parallel fan-out nodes editing the same files in one shared folder may conflict. Mitigation: documented; worktree isolation deferred; encourage role separation.
- LOW — YAML↔canvas round-trip fidelity. Mitigation: `layout` block + zod load validation.

## 6. Steps

- [ ] 1. Port `graphs.types.ts:11-20` schema + `graph-registry.ts:19-294` + the validation/topo-sort half of `graph-compiler.ts:40-233,582-645` to TS (drop NestJS DI). <!-- step-1 -->
- [ ] 2. Workflow YAML load/save (`*.geniro.yaml`, central library + import/export, `layout` block, zod). <!-- step-2 -->
- [ ] 3. Workflows page: port React Flow + elkjs canvas editor; bind to YAML. <!-- step-3 -->
- [ ] 4. DAG fan-out executor in daemon: topo walk, parallel independent nodes, edge text A→B + shared cwd (`graph-compiler.ts:235`). <!-- step-4 -->
- [ ] 5. Approval model: auto default + per-node ask → elicitation cards + verdict round-trip. <!-- step-5 -->
- [ ] 6. Chats page runs a workflow; per-node rendered transcripts; port Geniro graph-compiler tests. <!-- step-6 -->

## 7. Tools Required

- `@xyflow/react`, `elkjs`, `js-yaml`, `zod`; the M2 adapters + daemon.

## 8. Approval Points

- Demo checkpoint at M3 end (the headline feature).

## 9. Validation

- Compose a 2–3 node graph (e.g. coder → reviewer, with a Cursor fan-out) on the canvas, save as YAML, run it from Chats: topo-sorted execution, parallel fan-out, A's output reaches B, edits land in the shared folder; toggle a node to "ask" and approve a tool call. verify: pnpm --filter daemon test:graph

## 10. Rollback-Recovery

- `git revert` the M3 branch; graph layer is additive over M2 (single-agent chat still works).

## 11. Done Condition

- A user composes a DAG of agents on the canvas, saves it as a YAML workflow, and runs it as a team from a full-screen chat with DAG fan-out execution and working approvals.
