---
description: CLI agent adapters — abstract base class + one subdirectory per adapter
globs:
  - "apps/daemon/src/v1/agents/**"
---

# Agent adapters

## The one rule everything else follows from

**Every fact about a specific CLI lives in the adapter layer — behind an
abstract method on `AgentAdapter`, implemented in that CLI's own
`adapters/<name>/` subdirectory. Nothing else in the daemon may branch on which
agent it is talking to.**

That means all of it, not just the turn: the argv, the stream shapes, where the
CLI keeps its skills and commands on disk, what it reports about itself, which
models it accepts, which flags it understands, what it stores in the user's home
directory, what it cannot do at all. If you find yourself writing
`if (agent === 'claude')` in a service, controller, gateway, or util, the
condition belongs on the base class as a method every adapter answers — the
CLI that has no answer returns the empty one and **documents why in its
override**, which is how the reader learns the CLI has no such feature (see
`CursorAdapter.listReportedCommands` → `[]`, because cursor-agent has no
built-in slash commands).

Consumers **compose**, adapters **know**. A service decides WHEN to ask and what
to do with several answers; it never decides HOW to ask, and never encodes a
CLI's conventions. Reference pair: `ModelsService` / `SkillsService` (caching,
merging, ordering) over `listModels` / `listSkills` / `listReportedCommands`
(everything CLI-specific).

Adding a capability is therefore always the same three steps: an abstract
method on the base with the contract in its doc block → one implementation per
adapter, in that adapter's subdirectory → a consumer that calls it without
knowing which adapter answered.

## The base class contract

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
  - implement `listModels(options?)` — the models that CLI accepts for
    `--model`. Every CLI answers differently (cursor has a `models`
    subcommand; claude has none, so its adapter reads the account models the
    CLI caches in `~/.claude.json` for its own picker), so the SHAPE is fixed
    on the base and the how is per-adapter. It must never throw or hang: a CLI
    that cannot be asked returns its documented built-in set, so the picker is
    never empty. No model list belongs anywhere else — the renderer has none.
  - implement `listSkills(input)` — the skills / slash commands that CLI can be
    invoked with in a folder, found under ITS OWN roots (`.claude/skills` +
    `.claude/commands` vs `.cursor/commands`), project and `~`. The walking of
    the two on-disk shapes is shared (`adapters/skill-scan.ts`); the paths and
    the resolution order are the adapter's. Return them in the order the CLI
    itself would resolve a collision — the caller de-dupes first-occurrence-wins.
  - implement `listReportedCommands(options?)` — what the CLI says about
    ITSELF: the built-ins and plugin commands that exist nowhere on disk to be
    scanned. Claude answers by starting one headless turn and cancelling it the
    instant `system/init` lands (the list rides init, so it costs nothing);
    cursor-agent has no such report and returns `[]`. Never throws, never
    hangs. A turn a utility method starts is registered through `onTurn`, the
    handle-shaped sibling of `onSpawn`.
- Never wire `runHeadlessCli` (or `spawn`) directly from an adapter or service —
  the base class's `start()` is the single spawn path. For anything that is NOT
  a turn (a `models` subcommand, a `--version` probe) the one path is the base's
  `runCommand()`: an adapter never reaches for `execFile` itself, and the caller
  registers the child via `onSpawn` so shutdown can reap it.
- **Each adapter gets its own subdirectory** `adapters/<name>/` holding ALL of
  its classes, mapper functions, disk-convention scanners, probes,
  adapter-specific types, and specs (e.g. `adapters/claude/claude.adapter.ts`,
  `claude-models.ts`, `claude-skills.ts`, `claude-commands.ts`;
  `adapters/cursor/cursor.adapter.ts`, `cursor-models.ts`,
  `cursor-skills.ts`). A file named after one CLI never lives outside that
  CLI's subdirectory — not in `services/`, not in `utils/`. Its spec moves with
  it, so the tests that pin a CLI's conventions sit beside the code that
  encodes them.
- Shared adapter contract types (`AgentEvent`, `AgentUsage`, `AgentTurnInput`,
  `AgentTurnHandle`, `AgentSkillEntry`) live in `adapters/adapter.types.ts` —
  adapter-agnostic only; anything CLI-specific belongs in that adapter's
  subdirectory. A helper both adapters use (`adapters/skill-scan.ts`) sits at
  the `adapters/` root and must stay free of any one CLI's paths or names.
- **State the daemon keeps per agent is keyed by agent**, never by the thing it
  happens to be about. `SkillHarvestStore` keys its cache by (agent, cwd), not
  cwd alone: one folder is routinely used by both CLIs, and keying it loosely
  would have leaked claude's built-ins into a cursor listing — a bug an
  `if (agent === 'claude')` at the read site papers over instead of fixing.
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
