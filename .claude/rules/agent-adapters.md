---
description: CLI agent adapters — abstract base class + one subdirectory per adapter
globs:
  - "apps/daemon/src/v1/agents/**"
---

# Agent adapters

## The one rule

**Every fact about a specific CLI lives in that CLI's `adapters/<name>/`
directory — as a field of its `AdapterConfig` or behind an abstract method on
`AgentAdapter`. Nothing else in the daemon branches on which agent it is talking
to.**

All of it: argv, wire shapes, where it keeps skills on disk, what it reports
about itself, which flags it understands, what it cannot do at all. An
`if (agent === 'claude')` in a service, controller, gateway or util is a missing
config field or a missing method — never a condition at the read site. A CLI
with no answer declares that as a fact with the reason beside it
(`cursor-acp`'s `questionToolName: null`, `terminal: null`), which is how a
reader learns the feature does not exist.

Consumers **compose**, adapters **know**: a service decides WHEN to ask and what
to do with several answers, never HOW to ask. Reference pair: `ModelsService` /
`SkillsService` over `listModels` / `listSkills` / `listReportedCommands`.

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
  cancel, and the executor's fan-out are untouched either way. Nor does it
  exempt an adapter from the rule above — an ACP adapter still answers every
  per-CLI question through its own `AdapterConfig`.
- A second ACP-capable CLI composes `adapters/acp/`; it never copies the
  protocol. Compare `adapters/cursor-acp/cursor-acp.adapter.ts`: ~150 lines of
  binary name, env re-injection, an approval policy, and the mode mapping.

## Config field, or abstract method?

Ask what actually differs per CLI:

- **A value** → a field on `AdapterConfig` (`adapters/adapter.types.ts`), one
  entry per adapter in its `getConfig()` with the reason beside it, and ONE
  concrete implementation on the base reading `this.getConfig()`. No overrides.
- **A mechanism** (a home-file read vs a subcommand; two wire protocols) → an
  abstract method on the base, one implementation per adapter.

Reaching for a method where a field would do is how the base grew seven
near-identical overrides.

## The base class

A subclass supplies `getConfig()`, `buildArgs`, `mapMessage` and `listModels`.
Nothing else is required. Everything else is already concrete on the base and
driven by config — `listSkills`, `listEfforts`, `listReportedCommands`,
`supportsLiveStream`, `resolveApprovalMode`, `terminalCommand` — so **read the
base before writing an override.** The one sanctioned exception is
`approvalSupportFrom`: config can declare WHICH modes are probed, but not which
CLI-named field of the capability bag carries the verdict.

The optional hooks — `buildStdinPayload`, `buildEnv`, `keepStdinOpen`,
`buildApprovalResponse`, `prepareTurn`, `createTurnDriver`, `questionFrom`,
`withAnswer` — each carry their contract in their doc block. Override one only
when your CLI needs it; each default is the "this CLI has no such thing"
answer. Two deserve naming here:

- **`prepareTurn`** — only when a turn needs a resource materialized BEFORE the
  spawn and torn down when it settles. Return a disposer; the base runs it on
  exactly one exit path (once on `handle.done`, OR once on a synchronous
  `start()` throw), so every settle path frees the resource exactly once
  (claude's per-turn `--mcp-config` file for caller nodes writes and removes
  the 0600 config here — the call token rides the file, never argv).
- **`createTurnDriver`** — only when the CLI speaks a STATEFUL, bidirectional
  protocol whose next message depends on the last one received (ACP's JSON-RPC
  handshake). The default driver is stateless: it forwards each line to
  `mapMessage`, which is the whole protocol for a one-shot stream-json CLI.
  **Protocol state must live on the returned per-turn driver, never on the
  adapter** — one adapter instance serves N concurrent turns under graph
  fan-out, so an adapter field would cross-wire them. A driver may also open
  the conversation (`onStdinReady(io)`) and encode approval verdicts.

`start()` is the single spawn path for a turn, `runCommand()` for everything
else. An adapter never reaches for `spawn` or `execFile`, and every child is
registered (`onSpawn` / `onTurn`) so shutdown can reap it.

Adapters never throw HTTP exceptions. Return a discriminated result and let the
owning module map it — see `terminalCommand` → `TerminalCommandResult`.

## The call surface

- Every adapter must be able to hand its own CLI `input.mcpEndpoint` (claude's
  per-turn `--mcp-config` file, ACP's `session/new`). The graph executor assumes
  it: a node with outgoing call edges gets the endpoint, with no per-machine
  capability gate in between.
- **`input.callSurfacePrompt` is only true while those tools are actually
  registered.** Build the turn's instruction text with the base's
  `composeSystemPrompt(input, granted)`, passing whether YOUR delivery
  mechanism succeeded — never join the two prompt fields yourself. An agent told
  to route work through `call_agent` with no such tool registered never runs its
  callees and the node still reports success, which is silent by construction.
  This is why the fields are separate: a single pre-composed string could not be
  conditionally withheld. An adapter for a CLI that can only read MCP config
  from a well-known on-disk path would need that gate — and the surrounding
  plant/restore lifecycle — reintroduced deliberately.

## Layout

`adapters/<name>/` holds ALL of that CLI's code: `<name>.adapter.ts` at its
root, alongside `<name>.const.ts` / `<name>.types.ts` **when that CLI has
constants or types to name**, every pure helper in
`<name>/utils/<name>-<subject>.utils.ts`, and that CLI's own probe and per-turn
lifecycle services (`claude/claude-probe.service.ts`). **A file named after one
CLI never lives outside that CLI's directory** — not in `services/`, not in
`utils/`, not in another module. Specs move with their file. (`v1/agents`'s
`cursor-mcp-cleanup` util + service are the one live exception, and an expiring
one: they clean up after the DELETED legacy transport and are removed a release
after shipping.)

**A protocol several CLIs could speak lives in its own `adapters/<protocol>/`
directory**, agent-agnostic: `adapters/acp/` holds the Agent Client Protocol
client (`acp.types.ts` wire shapes, `acp-jsonrpc.ts` framing, `acp-content.ts`
attachment blocks, `acp-driver.ts` the per-turn state machine) and knows
nothing about cursor.

Adapter-agnostic contract types and constants live in
`adapters/adapter.types.ts`; a helper the base uses for every adapter lives in
`adapters/utils/` (`skill-scan.utils.ts`) and stays free of any one CLI's paths
or names.

## Non-negotiables

- **Constants live in `<name>.const.ts` — except the config literal's own.**
  Argv flags, timeouts, file names, env var names, message templates are named
  exports there, under section comments: a name is where the doc block lives,
  and it is what stops two readers drifting (`CLAUDE_PARTIAL_MESSAGES_FLAG` is
  ONE string used both by `buildArgs` and by the `--help` scan, so they cannot
  disagree about it). The exception is a static fact `getConfig()` is the only
  reader of — write it inline in that literal, beside the field it answers. A
  name nothing else ever says buys nothing and only puts the value one file
  away from the shape that gives it meaning. An adapter whose every fact takes
  that exception needs no `.const.ts` at all (`cursor-acp`).
- **An agent is named, never spelled.** `AgentKind.Claude` /
  `AgentKind.CursorAgent` (`v1/runs/runs.types.ts`), which also drives
  `AgentKindSchema` — a bare `'claude'` string is a typo away from a branch
  that silently never matches.
- **Env scoping.** `runHeadlessCli` strips every `GENIRO_`-prefixed var; an
  adapter re-injects only the ONE secret its own CLI needs
  (`CursorAcpAdapter.buildEnv` → `CURSOR_API_KEY`). No adapter leaks a
  credential into another agent's child.
- **Per-agent state is keyed by agent**, never by the thing it is about.
  `SkillHarvestStore` keys by (agent, cwd): one folder is routinely used by both
  CLIs, and keying it loosely leaked claude's built-ins into a cursor listing.
- **The testable unit stays free of a process.** A stream-json mapper is an
  exported pure function in `<name>/utils/<name>-message.utils.ts` and the class
  method delegates to it; an ACP adapter has no mapper at all — its per-turn
  driver is the unit, and `adapters/acp/acp-driver.spec.ts` drives it with no
  child process.
- Adapters are provided in `agents.module.ts` via factory providers — the
  options bag is a test seam, not a DI token.
