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

All of it: argv, stream shapes, where it keeps skills on disk, what it reports
about itself, which flags it understands, what it cannot do at all. An
`if (agent === 'claude')` in a service, controller, gateway or util is a missing
config field or a missing method — never a condition at the read site. A CLI
with no answer declares that as a fact with the reason beside it
(`cursor.const.ts`'s `reportedCommands: null`), which is how a reader learns the
feature does not exist.

Consumers **compose**, adapters **know**: a service decides WHEN to ask and what
to do with several answers, never HOW to ask. Reference pair: `ModelsService` /
`SkillsService` over `listModels` / `listSkills` / `listReportedCommands`.

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
`buildApprovalResponse`, `prepareTurn`, `questionFrom`, `withAnswer` — each
carry their contract in their doc block. Override one only when your CLI needs
it; each default is the "this CLI has no such thing" answer.

`start()` is the single spawn path for a turn, `runCommand()` for everything
else. An adapter never reaches for `spawn` or `execFile`, and every child is
registered (`onSpawn` / `onTurn`) so shutdown can reap it.

Adapters never throw HTTP exceptions. Return a discriminated result and let the
owning module map it — see `terminalCommand` → `TerminalCommandResult`.

## Layout

`adapters/<name>/` holds ALL of that CLI's code: exactly three files at its root
(`<name>.adapter.ts`, `<name>.const.ts`, `<name>.types.ts`), every pure helper
in `<name>/utils/<name>-<subject>.utils.ts`, and that CLI's own probe and
per-turn lifecycle services (`claude-probe.service.ts`,
`cursor-mcp-merge.service.ts`). **A file named after one CLI never lives outside
that CLI's directory** — not in `services/`, not in `utils/`, not in another
module. Specs move with their file.

Adapter-agnostic contract types and constants live in
`adapters/adapter.types.ts`; a helper the base uses for every adapter lives in
`adapters/utils/` and stays free of any one CLI's paths or names.

## Non-negotiables

- **Constants live in `<name>.const.ts` — except the config literal's own.**
  Argv flags, timeouts, file names, env var names, message templates are named
  exports there, under section comments: a name is where the doc block lives,
  and it is what stops two readers drifting (`CLAUDE_PARTIAL_MESSAGES_FLAG` is
  ONE string used both by `buildArgs` and by the `--help` scan, so they cannot
  disagree about it). The exception is a static fact `getConfig()` is the only
  reader of — write it inline in that literal, beside the field it answers. A
  name nothing else ever says buys nothing and only puts the value one file
  away from the shape that gives it meaning.
- **An agent is named, never spelled.** `AgentKind.Claude` /
  `AgentKind.CursorAgent` (`v1/runs/runs.types.ts`), which also drives
  `AgentKindSchema` — a bare `'claude'` string is a typo away from a branch
  that silently never matches.
- **Env scoping.** `runHeadlessCli` strips every `GENIRO_`-prefixed var; an
  adapter re-injects only the ONE secret its own CLI needs (`CursorAdapter` →
  `CURSOR_API_KEY`). No adapter leaks a credential into another agent's child.
- **Per-agent state is keyed by agent**, never by the thing it is about.
  `SkillHarvestStore` keys by (agent, cwd): one folder is routinely used by both
  CLIs, and keying it loosely leaked claude's built-ins into a cursor listing.
- **Mappers stay exported pure functions** in
  `<name>/utils/<name>-message.utils.ts`, so specs drive them without spawning;
  the class method delegates.
- Adapters are provided in `agents.module.ts` via factory providers — the
  options bag is a test seam, not a DI token.
