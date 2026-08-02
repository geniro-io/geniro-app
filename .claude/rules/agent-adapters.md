---
description: CLI agent adapters — abstract base class + one subdirectory per adapter
globs:
  - "apps/daemon/src/v1/agents/**"
---

# Agent adapters

## ACP first — the default transport for any new agent

- **When adding an agent, check whether its CLI speaks ACP (the Agent Client
  Protocol) and prefer that transport if it does.** Most coding CLIs now ship
  one (`cursor-agent acp`, Gemini CLI, Copilot CLI, Goose, Cline, OpenHands,
  Amp…), and an ACP adapter is a thin wrapper over the existing
  `adapters/acp/` client rather than a new bespoke integration.
- Reach for a CLI's proprietary headless mode (`-p --output-format
  stream-json`) only when ACP is genuinely unavailable, and say so in the
  adapter's doc block so the choice is revisited when the CLI catches up.
- Why ACP wins for this codebase, concretely — each of these was a hand-rolled
  subsystem on the legacy cursor path, and all of them were deleted with it:
  - **Permissions.** `session/request_permission` is an ACP baseline, so
    `ask`/`acceptEdits` are real. A CLI without a permission protocol forces
    every mode to degrade to auto-approve.
  - **MCP delivery.** Client-supplied `mcpServers` in `session/new` carries a
    caller node's call endpoint in-protocol, with the token on an HTTP header
    inside a stdin frame. The alternative is planting the endpoint in a
    well-known config file in the user's own worktree — which cost a per-cwd
    mutex, a write journal, backup/surgical-restore, boot reconciliation, and
    a one-shot trust probe gating the whole call runtime.
  - **A typed event stream.** `session/update` has a published schema;
    proprietary NDJSON is version-volatile and needs a deliberately liberal
    mapper that guesses across CLI releases.
- What ACP does NOT change: one turn is still one process, so `ProcessRegistry`,
  cancel, and the executor's fan-out are untouched either way.
- A second ACP-capable CLI composes `adapters/acp/` — it never copies the
  protocol. Compare `adapters/cursor-acp/cursor-acp.adapter.ts`: ~150 lines of
  binary name, env re-injection, an approval policy, and the mode mapping.

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
  - override `createTurnDriver(input)` only when the CLI speaks a STATEFUL,
    bidirectional protocol whose next message depends on the last one received
    (ACP's JSON-RPC handshake). The default driver is stateless — it forwards
    each line to `mapMessage` — which is the whole protocol for a one-shot
    stream-json CLI. **Protocol state must live on the returned per-turn
    driver, never on the adapter**: one adapter instance serves N concurrent
    turns under graph fan-out, so an adapter field would cross-wire them. A
    driver may also open the conversation (`onStdinReady(io)`) and encode
    approval verdicts (`buildApprovalResponse`)
  - every adapter must be able to hand its own CLI `input.mcpEndpoint` (claude's
    per-turn `--mcp-config` file, ACP's `session/new`). The graph executor
    assumes it: a node with outgoing call edges gets the endpoint, with no
    per-machine capability gate in between. An adapter for a CLI that can only
    read MCP config from a well-known on-disk path would need that gate — and
    the surrounding plant/restore lifecycle — reintroduced deliberately
- Never wire `runHeadlessCli` (or `spawn`) directly from an adapter or service —
  the base class's `start()` is the single spawn path.
- **Each adapter gets its own subdirectory** `adapters/<name>/` holding ALL of its
  classes, mapper functions, adapter-specific types, and specs
  (e.g. `adapters/claude/claude.adapter.ts`,
  `adapters/cursor-acp/cursor-acp.adapter.ts`).
- **A protocol several CLIs could speak lives in its own `adapters/<protocol>/`
  directory**, agent-agnostic, and each adapter composes it: `adapters/acp/`
  holds the Agent Client Protocol client (`acp.types.ts` wire shapes,
  `acp-jsonrpc.ts` framing, `acp-driver.ts` the per-turn state machine) and
  knows nothing about cursor. A second ACP-capable CLI gets a thin adapter over
  the same driver — never a second copy of the protocol.
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
  needs (see `CursorAcpAdapter.buildEnv` → `CURSOR_API_KEY`). No adapter may leak a
  credential into another agent's child process.
