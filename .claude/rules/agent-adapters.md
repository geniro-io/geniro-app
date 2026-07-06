---
description: CLI agent adapters — abstract base class + one subdirectory per adapter
globs:
  - "apps/daemon/src/v1/agents/**"
---

# Agent adapters

- Every CLI agent adapter **extends the abstract `AgentAdapter` base class**
  (`apps/daemon/src/v1/agents/adapters/agent-adapter.ts`). The base owns the one
  shared turn flow (spawn via `runHeadlessCli`, NDJSON reassembly, normalized
  terminal outcomes); a subclass contributes only what differs per CLI:
  - `kind` — the `AgentKind` it drives
  - `command` — the CLI binary
  - `buildArgs(input)` — the argv for one turn
  - `mapMessage(obj)` — maps one parsed stream-json line to normalized `AgentEvent`s
  - override `buildStdinPayload(input)` only when the CLI reads its prompt from stdin
  - override `buildEnv(input)` only when the CLI needs a secret re-injected
  - override `keepStdinOpen(input)` only when the CLI holds a mid-turn stdin
    dialogue (Claude's `ask` approval mode — stdin closes on the terminal event)
  - override `buildApprovalResponse(id, allow, updatedInput)` only when the CLI
    has an approval wire protocol (Claude's stream-json `control_response`);
    the default `undefined` makes `respondApproval` a no-op
  - override `prepareTurn(input)` only when a turn needs a resource materialized
    BEFORE the spawn and torn down when it settles — return a disposer; the base
    runs it on exactly one exit path (once on `handle.done`, OR once on a
    synchronous `start()` throw), so every settle path frees the resource
    exactly once (Claude's per-turn `--mcp-config` file for caller nodes
    writes/removes the 0600 config here — the call token rides the file, never
    argv)
- Never wire `runHeadlessCli` (or `spawn`) directly from an adapter or service —
  the base class's `start()` is the single spawn path.
- **Each adapter gets its own subdirectory** `adapters/<name>/` holding ALL of its
  classes, mapper functions, adapter-specific types, and specs
  (e.g. `adapters/claude/claude.adapter.ts`, `adapters/cursor/cursor.adapter.ts`).
- Shared adapter contract types (`AgentEvent`, `AgentUsage`, `AgentTurnInput`,
  `AgentTurnHandle`) live in `adapters/adapter.types.ts` — adapter-agnostic only;
  anything CLI-specific belongs in that adapter's subdirectory.
- Keep mappers exported as standalone pure functions (`mapClaudeMessage`,
  `mapCursorMessage`) so specs can drive them without spawning; the class method
  delegates to them.
- Adapters are provided in `agents.module.ts` via factory providers
  (`{ provide: ClaudeAdapter, useFactory: () => new ClaudeAdapter() }`) — their
  options bag is a test seam, not a DI token.
- Env scoping is non-negotiable: `runHeadlessCli` strips every `GENIRO_`-prefixed
  var from the child env; an adapter re-injects only the ONE secret its own CLI
  needs (see `CursorAdapter.buildEnv` → `CURSOR_API_KEY`). No adapter may leak a
  credential into another agent's child process.
