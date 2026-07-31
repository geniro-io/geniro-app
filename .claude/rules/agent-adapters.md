---
description: CLI agent adapters — abstract base class + one subdirectory per adapter
globs:
  - "apps/daemon/src/v1/agents/**"
---

# Agent adapters

## The one rule everything else follows from

**Every fact about a specific CLI lives in the adapter layer — as a field of
that adapter's `AdapterConfig` or behind an abstract method on `AgentAdapter`,
declared in that CLI's own `adapters/<name>/` subdirectory. Nothing else in the
daemon may branch on which agent it is talking to.**

That means all of it, not just the turn: the argv, the stream shapes, where the
CLI keeps its skills and commands on disk, what it reports about itself, which
models it accepts, which flags it understands, what it stores in the user's home
directory, what it cannot do at all. If you find yourself writing
`if (agent === 'claude')` in a service, controller, gateway, or util, the
condition belongs on the base class — as a config field, or as a method every
adapter answers — never at the read site. The CLI that has no answer says so
**as a declared fact with the reason beside it**, which is how the reader
learns the CLI has no such feature (see `cursor.const.ts`'s
`reportedCommands: null`, whose comment records that cursor-agent has no such
report).

Consumers **compose**, adapters **know**. A service decides WHEN to ask and what
to do with several answers; it never decides HOW to ask, and never encodes a
CLI's conventions. Reference pair: `ModelsService` / `SkillsService` (caching,
merging, ordering) over `listModels` / `listSkills` / `listReportedCommands`
(everything CLI-specific).

Adding a capability starts with one question: is the only per-CLI input a
VALUE, or is it a MECHANISM?

- A value → a field on `AdapterConfig` (`adapters/adapter.types.ts`) with the
  contract in its doc block → one entry per adapter in its `<name>.const.ts`,
  the reason beside it → ONE concrete implementation on the base reading
  `this.config`. No adapter overrides anything.
- A mechanism (a home-file read vs a subcommand; two different wire protocols)
  → an abstract method on the base with the contract in its doc block → one
  implementation per adapter, in that adapter's subdirectory → a consumer that
  calls it without knowing which adapter answered.

Reaching for an abstract method when a config field would do is how the base
grew seven near-identical overrides the refactor deleted.

## The base class contract

- Every CLI agent adapter **extends the abstract `AgentAdapter` base class**
  (`apps/daemon/src/v1/agents/adapters/agent-adapter.ts`). The base owns the one
  shared turn flow (spawn via `runHeadlessCli`, NDJSON reassembly, normalized
  terminal outcomes); a subclass contributes only what differs per CLI:
  - `config` — the adapter's `AdapterConfig`, declared in `<name>.const.ts`. It
    carries every STATIC fact (kind, question tool, approval policy, effort
    vocabulary, builtin models, skill roots, live-stream flag, reported-commands
    probe, MCP traits, terminal traits). `command` is derived from `config.kind`
    on the base and is never declared per adapter.
  - `buildArgs(input)` — the argv for one turn
  - `mapMessage(obj)` — maps one parsed stream-json line to normalized
    `AgentEvent`s. These two are the only abstract METHODS a subclass must
    implement, plus `listModels(options?)`, the one list whose MECHANISM is
    per-CLI.
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
    The documented fallback set is `config.builtinModels`, in
    `<name>.const.ts`; only the way it is OBTAINED lives in the override.
  - do NOT implement `listSkills` — the base scans `config.skillRoots` (project
    cwd then `~`, skills before commands within each root, which IS the CLI's
    own shadowing order, and what the caller's first-occurrence-wins de-dup
    relies on). The PATHS are the adapter's and live in `<name>.const.ts`
    (`.claude/skills` + `.claude/commands` vs `.cursor/commands`); the walking
    of the two on-disk shapes is shared in `adapters/utils/skill-scan.utils.ts`.
  - do NOT implement `listEfforts`, `supportsLiveStream`,
    `resolveApprovalMode` or `approvalSupportFrom` either — all four are
    concrete on the base over `config.efforts`, `config.liveStream` (null = no
    such mode, answered without spawning), `config.approval.{modes,
    probedModes, degradeOnProbeFail, soleModeDegradeReason}` and the
    `{ supported: {} }` default. `approvalSupportFrom` is the ONE of them an
    adapter may still override, and only for the reason claude does: config can
    declare WHICH modes are probed, but not which CLI-NAMED field of the
    capability bag carries the verdict.
  - do NOT implement `listReportedCommands` either — the base runs the
    init-cancel probe when `config.reportedCommands` is set (one headless turn
    in a throwaway cwd under `probeRootDir`, cancelled the instant the
    normalized `slash_commands` event lands, so the list costs nothing) and
    answers `[]` without spawning when it is null. The probe prompt, timeout,
    cap and internal-name prefix are values in `<name>.const.ts`. Never throws,
    never hangs. A turn the base starts for a utility method is registered
    through `onTurn`, the handle-shaped sibling of `onSpawn`.
  - do NOT implement `terminalCommand(sessionId)` — it is concrete over
    `config.terminal` (null = the CLI has no resume mode, so the mirror is
    refused rather than opening an unrelated fresh TUI) and returns a
    discriminated `TerminalCommandResult`, never an HTTP exception; the
    terminals module maps the refusal onto its own error codes.
  - override `questionFrom(input)` / `withAnswer(input, answer)` only when the
    CLI has a question channel at all (`config.questionToolName` non-null) —
    the defaults are `null` and the untouched input. They are what keeps the
    graph executor and `utils/approval-answer` free of any claude-named import:
    each delegates to that CLI's own `<name>/utils/<name>-question.utils.ts`.
- Never wire `runHeadlessCli` (or `spawn`) directly from an adapter or service —
  the base class's `start()` is the single spawn path. For anything that is NOT
  a turn (a `models` subcommand, a `--version` probe) the one path is the base's
  `runCommand()`: an adapter never reaches for `execFile` itself, and the caller
  registers the child via `onSpawn` so shutdown can reap it.
- **Each adapter gets its own subdirectory** `adapters/<name>/` holding ALL of
  its classes, mapper functions, disk-convention scanners, probes,
  adapter-specific types, and specs. Its layout is fixed: exactly three files
  at an adapter root — `<name>.adapter.ts`, `<name>.const.ts` (ALL of that
  CLI's constants, grouped under section comments, assembling `<NAME>_CONFIG`
  at the bottom), `<name>.types.ts` (that CLI's own types) — with every pure
  helper in `<name>/utils/` as `<name>-<subject>.utils.ts`. Its probe service
  and any per-turn lifecycle service it owns live at the adapter root too
  (`claude-probe.service.ts`, `cursor-probe.service.ts`,
  `cursor-mcp-merge.service.ts`); a file named after one CLI never lives
  outside that CLI's subdirectory — not in `services/`, not in `utils/`, not in
  another module. Specs move with their file, so the tests that pin a CLI's
  conventions sit beside the code that encodes them.
- Shared adapter contract types (`AdapterConfig`, `AdapterQuestion`,
  `TerminalCommandResult`, `AgentEvent`, `AgentUsage`, `AgentTurnInput`,
  `AgentTurnHandle`, `AgentSkillEntry`) live in `adapters/adapter.types.ts` —
  adapter-agnostic only; anything CLI-specific belongs in that adapter's
  subdirectory. A helper the BASE uses for every adapter
  (`adapters/utils/skill-scan.utils.ts`) sits in `adapters/utils/` and must stay
  free of any one CLI's paths or names.
- **NO constant is declared in an adapter's `.adapter.ts` or in a `utils/`
  file.** Every value a CLI needs — argv literals, flags, timeouts, file names,
  env var names, message templates, wire-vocabulary strings — is a named
  `export const` in `<name>.const.ts` under a section comment, and
  `<NAME>_CONFIG` is assembled from them at the bottom of that file.
- **State the daemon keeps per agent is keyed by agent**, never by the thing it
  happens to be about. `SkillHarvestStore` keys its cache by (agent, cwd), not
  cwd alone: one folder is routinely used by both CLIs, and keying it loosely
  would have leaked claude's built-ins into a cursor listing — a bug an
  `if (agent === 'claude')` at the read site papers over instead of fixing.
- Keep mappers exported as standalone pure functions (`mapClaudeMessage`,
  `mapCursorMessage`) so specs can drive them without spawning; they live in
  `<name>/utils/<name>-message.utils.ts` and the class method delegates to them.
- Adapters are provided in `agents.module.ts` via factory providers
  (`{ provide: ClaudeAdapter, useFactory: () => new ClaudeAdapter() }`) — their
  options bag is a test seam, not a DI token.
- Env scoping is non-negotiable: `runHeadlessCli` strips every `GENIRO_`-prefixed
  var from the child env; an adapter re-injects only the ONE secret its own CLI
  needs (see `CursorAdapter.buildEnv` → `CURSOR_API_KEY`). No adapter may leak a
  credential into another agent's child process.
