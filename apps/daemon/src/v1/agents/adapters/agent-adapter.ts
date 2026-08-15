import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAgentBinary } from '../utils/agent-binary';
import { buildChildEnv } from '../utils/child-env';
import { trackDetachedChild } from '../utils/child-journal';
import { createGroupTerminator } from '../utils/kill-tree';
import {
  type BetweenTurnApproval,
  type CliSession,
  runCliSession,
  type SessionLogger,
  type SpawnFn,
} from '../utils/spawn-cli';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentContextUsage,
  AgentContextUsageInput,
  AgentEffort,
  AgentErrorRecovery,
  AgentEvent,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpServerHealth,
  AgentMcpServerHealthInput,
  AgentMcpServersInput,
  AgentModel,
  AgentSession,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentSpawnInfo,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
  FollowUpMessage,
  HandoffInput,
  HandoffResult,
  InstalledApprovalSupport,
  InstalledCapabilities,
  TurnDriver,
} from './adapter.types';
import { scanCommandFiles, scanSkillDirs } from './utils/skill-scan.utils';

/** Utility commands (`models`, `--version`) answer fast or not at all. */
const UTILITY_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Stdout retained from a group-spawned utility command, in JS string length
 * — UTF-16 code units, NOT bytes. `execFile` gets a byte cap from node; the
 * `spawn` path collects by hand, and comparing decoded length is both cheaper
 * and the number that actually bounds the string we are holding. The point is
 * a ceiling at all: an unbounded string built from a chatty child is a
 * daemon-wide memory fault, not a failed read.
 */
const UTILITY_COMMAND_MAX_BUFFER_CHARS = 1024 * 1024;

/**
 * Constructor options every adapter accepts — test seams, not user config. The
 * option bag is not a DI token, so `agents.module.ts` provides each adapter via
 * a factory.
 */
export interface AgentAdapterOptions {
  /** Replacement spawn for tests; defaults to the group-leader `defaultSpawn`. */
  spawn?: SpawnFn;
  /**
   * Sink for the base class's diagnostics — skipped unparseable lines,
   * unmodelled control subtypes, a failed turn-resource disposer. Defaults to
   * silent, so production wiring MUST pass a real one (`agents.module.ts`).
   *
   * Every base-class diagnostic is a WARNING, so a plain `{ warn }` double
   * still satisfies this. `SessionLogger`'s optional `debug` is what the turn
   * transport writes its per-tool-call account to (the approval round-trip,
   * the turn boundaries) — a Nest `Logger` carries it, a test double need not.
   */
  logger?: SessionLogger;
  /** Replacement execFile for the utility commands in tests; defaults to node's. */
  execFileFn?: typeof execFile;
  /**
   * Replacement spawn for the utility commands that run as their own process
   * group ({@link AgentCommandOptions.processGroup}); defaults to the
   * group-leader `defaultSpawn`.
   *
   * A THIRD seam rather than a reuse of either neighbour, because all three
   * describe different children: `spawn` is the turn, `execFileFn` is a
   * plain utility command, and this is a group-led one. Folding it into
   * `spawn` would make a spec that fakes a turn silently intercept a listing
   * as well, and the two adapter specs that fake both would then cross-wire.
   */
  groupSpawnFn?: typeof spawn;
  /**
   * Root for the throwaway workspace {@link AgentAdapter.listReportedCommands}
   * runs its probe turn in (the daemon passes its own userData tmp dir, never
   * a user folder); falls back to the OS tmpdir for standalone/spec use.
   */
  probeRootDir?: string;
}

/**
 * Base class for a headless CLI coding-agent adapter. Owns the one shared turn
 * flow — spawn via {@link runHeadlessCli} (which strips `GENIRO_`-prefixed env,
 * reassembles stdout NDJSON, and normalizes terminal outcomes) — while each
 * subclass contributes only what differs per CLI: the command, its argv, the
 * NDJSON→{@link AgentEvent} mapper, and (when the CLI needs it) a stdin payload
 * or extra child env. One instance per agent kind; `start` is called per turn.
 */
export abstract class AgentAdapter {
  /**
   * Everything STATIC about the CLI this adapter drives — the single source of
   * every per-CLI VALUE, which is why the members below are concrete here
   * rather than restated per adapter.
   *
   * A method returning an inline literal, not a field pointing at a const: the
   * adapter class is then the one place that shows what its CLI is, and the
   * annotated return type makes a missing or misspelled field a type error at
   * the adapter instead of at some distant read site. A value belongs wherever
   * its readers are — a named export in `<name>.const.ts` once something
   * BESIDES this literal reads it, so the two cannot drift apart; written
   * inline beside the field it answers when this literal is its only reader.
   */
  abstract getConfig(): AdapterConfig;

  /**
   * The CLI binary invoked for each turn. Resolved per access so the Settings
   * cliPaths override (`GENIRO_<AGENT>_BIN` on the daemon env) takes effect
   * without reconstructing the adapter.
   */
  protected get command(): string {
    return resolveAgentBinary(this.getConfig().kind);
  }

  /**
   * Translate the daemon's machine-capability bag into THIS CLI's installed
   * approval support.
   *
   * The bag is adapter-agnostic (`GET /v1/capabilities`), so every consumer can
   * hold one without knowing whose probe filled which field — and each adapter
   * reads only its own. Without this the translation lived in the consumers:
   * both of them imported claude's, and the gate in front of it was
   * `config.approval.probedModes.includes(mode)` rather than "is this
   * claude", so a second CLI declaring any probed mode would have been judged
   * against CLAUDE's installed binary and silently degraded.
   *
   * The default answers `{ supported: {} }` — absent, never `false` — which is
   * the whole truth for a CLI with nothing to probe (`config.approval.
   * probedModes: []`): a mode nobody asked about is still attempted and any
   * genuine rejection surfaces from the CLI itself. Only an adapter whose
   * probe verdict lives under a CLI-NAMED field of the bag overrides this;
   * config can declare WHICH modes are probed, but not which field holds the
   * answer.
   */
  approvalSupportFrom(
    // Declared and deliberately unread here: taking the bag and returning
    // nothing from it is the STATEMENT — an adapter with no probed mode has no
    // field in there that is about its CLI. Omitting the parameter would make
    // the same test pass by signature rather than by behaviour.
    _capabilities: InstalledCapabilities,
  ): InstalledApprovalSupport {
    return { supported: {} };
  }

  /**
   * The mode a turn actually runs under, given what a probe proved about the
   * installed binary — plus the line the transcript owes the user when that is
   * not the mode they asked for.
   *
   * The ONE answer behind every approval seam (the chat turn and each graph
   * node alike), because the two encoding it separately is exactly how a
   * degrade gets fixed on one path and silently missed on the other. Policy
   * lives here, not in the caller: which modes degrade, which ride through to
   * be rejected loudly by the CLI, and what the user is told.
   *
   * The policy itself is per-CLI DATA (`config.approval`), so this is concrete
   * and the order is fixed for everyone:
   *
   * 1. A CLI with exactly ONE honoured mode collapses onto it — that comes
   *    FIRST because a single-mode CLI has nothing to probe, so a probe-table
   *    entry could otherwise route a turn to a mode the CLI does not honour at
   *    all.
   * 2. Otherwise a mode a probe PROVED the installed binary rejects degrades
   *    per `config.approval.degradeOnProbeFail` — only on `false`, never on an
   *    absent verdict.
   * 3. Otherwise the requested mode rides through, so a real rejection comes
   *    from the CLI instead of from a guess made here. A probed mode left OUT
   *    of the table takes this path deliberately (see claude's `plan`).
   */
  resolveApprovalMode(
    requested: AgentApprovalMode,
    installed: InstalledApprovalSupport,
  ): ApprovalResolution {
    const { modes, degradeOnProbeFail, soleModeDegradeReason } =
      this.getConfig().approval;
    const [soleMode] = modes;
    if (modes.length === 1 && soleMode && soleMode !== requested) {
      return {
        mode: soleMode,
        degradeReason: soleModeDegradeReason?.(requested) ?? null,
      };
    }
    const degrade = degradeOnProbeFail[requested];
    if (degrade && installed.supported[requested] === false) {
      return { mode: degrade.to, degradeReason: degrade.reason };
    }
    return { mode: requested, degradeReason: null };
  }

  /**
   * Project one question this CLI asked into the CLI-agnostic
   * {@link AdapterQuestion} a caller envelope or a renderer card is built
   * from, or null when the payload carries no question at all.
   *
   * The input is the question tool's own arguments — a shape only this CLI's
   * adapter knows. Consumers hold a payload they must never parse: the graph
   * executor bridges a callee's question to its caller without knowing which
   * CLI raised it, which is exactly what this method buys.
   *
   * The base answers null, the whole truth for a CLI whose
   * `config.questionToolName` is null: it has no question channel, so nothing
   * it emits can be a question. Only an adapter whose CLI HAS one overrides
   * this, delegating to a projection in its own `utils/`.
   */
  questionFrom(_input: unknown): AdapterQuestion | null {
    return null;
  }

  /**
   * Fold a free-text answer back into this CLI's question-tool input, so the
   * verdict the CLI receives carries the answer the user (or a calling agent)
   * gave.
   *
   * The counterpart of {@link questionFrom} on the way back, and the only
   * sanctioned mutation of a tool input anywhere: the base echoes the input
   * UNCHANGED, because a CLI with no question channel has no field to fold
   * into and inventing one would hand a tool an argument it never asked for.
   */
  withAnswer(input: unknown, _answer: string): unknown {
    return input;
  }

  /**
   * The env that puts an invocation in ONE config directory — the profile a
   * run belongs to — or `{}` when there is none to state.
   *
   * Shared by every invocation this class hands the user (resume, CLI sign-in,
   * MCP sign-in) because they are all about the same profile: a sign-in run
   * against the default directory cannot fix a run whose session lives in
   * another one, and a resume there would open an unrelated conversation. The
   * var name is the adapter's own fact (`config.configDir.envVar`), so no
   * caller spells it.
   */
  protected configDirEnv(
    configDir: string | null | undefined,
  ): Record<string, string> {
    const trimmed = configDir?.trim();
    const envVar = this.getConfig().configDir.envVar;
    return trimmed && envVar ? { [envVar]: trimmed } : {};
  }

  /**
   * The interactive TUI invocation that mirrors one of this CLI's headless
   * sessions — the same conversation the run produced, reopened in the CLI's
   * own terminal UI.
   *
   * Config-driven and concrete: `config.terminal` carries the resume flag and
   * what a resumable session id looks like for this CLI, so no consumer spells
   * a binary, a flag or an id shape. A CLI with `terminal: null` has no such
   * mode at all and answers `unsupported`, rather than being handed another
   * CLI's argv.
   *
   * It RETURNS the refusal instead of throwing: the two failure arms mean
   * different things to the HTTP caller (a CLI that will never mirror vs a
   * session that does not exist YET), and mapping them to status codes is the
   * consuming module's job — the adapter layer stays free of HTTP exceptions.
   *
   * A missing or foreign-shaped session id is `no-session`, never a bare TUI
   * launch: opening the CLI without a resume target would show an unrelated
   * fresh conversation while claiming to mirror the run.
   */
  handoffTarget(input: HandoffInput): HandoffResult {
    const handoff = this.getConfig().handoff;
    if (handoff.kind === 'unavailable') {
      return { ok: false, reason: 'unsupported' };
    }
    const trimmed = input.sessionId?.trim();
    if (!trimmed || !handoff.sessionIdPattern.test(trimmed)) {
      return { ok: false, reason: 'no-session' };
    }
    // The run's OWN model, when the CLI can be told. A mirror that opened on
    // the CLI's default was a different model with a different window beside
    // the chat it was supposed to be mirroring.
    const model = input.model?.trim();
    // The run's OWN config directory, for the same reason and one step
    // further: the session being resumed lives INSIDE that profile, so an
    // invocation without it does not merely open a different account — it
    // opens an unrelated conversation, since the id it resumes is not in the
    // default profile's store. It rides env because that is the only channel
    // the CLI has for it (`config.configDir.envVar`).
    return {
      ok: true,
      kind: 'command',
      command: this.command,
      args: [
        ...(model ? [handoff.modelFlag, model] : []),
        handoff.resumeFlag,
        trimmed,
      ],
      env: this.configDirEnv(input.configDir),
    };
  }

  /**
   * Why this CLI can never reopen one of its conversations, or `null` when it
   * can — the PERMANENT half of {@link handoffTarget}'s two refusals, asked
   * without a session to ask about.
   *
   * Its own method because two consumers need the answer and only one of them
   * has a run: `HandoffService` explains a specific thread, while
   * `CapabilitiesService` reports what each CLI can do at all, before any
   * conversation exists. That one used to fake a session id
   * (`sessionId: 'capability-probe'`) to reach this verdict through
   * `handoffTarget`, then throw the adapter's sentence away and compose
   * `"<agent> has no interactive terminal session"` of its own — so the run
   * route and the capability route gave two different answers to one question,
   * and the invented one was the only one the panel ever showed.
   *
   * A SENTENCE, like the other `unavailableReason` fields, because it is
   * rendered on an inert control: "no button" with no cause is exactly what
   * these fields exist to replace.
   */
  handoffUnavailableReason(): string | null {
    const handoff = this.getConfig().handoff;
    return handoff.kind === 'unavailable' ? handoff.reason : null;
  }

  /**
   * How the user signs this CLI in to ONE MCP server, or that it cannot.
   *
   * Shaped like {@link handoffTarget} and delivered the same way — resolved
   * here, run by the user's own terminal — and that is a constraint rather than
   * a preference: both CLIs' `mcp login` refuse a non-TTY stdin outright (the
   * probe is recorded on `AdapterConfig.mcp.loginArgs`), so there is no
   * headless spawn being passed over.
   *
   * Only `unsupported` can come back. A server NAME cannot be wrong here the
   * way a session id can — the caller took it from a listing this same CLI
   * produced — so there is no `no-session` counterpart to invent.
   */
  mcpLoginTarget(server: string, configDir?: string | null): HandoffResult {
    const { loginArgs } = this.getConfig().mcp;
    if (loginArgs === null) {
      return { ok: false, reason: 'unsupported' };
    }
    return {
      ok: true,
      kind: 'command',
      command: this.command,
      args: [...loginArgs, server],
      // A server is authorized INSIDE a profile: signing in under the default
      // directory leaves the run's own profile exactly as unauthenticated as
      // it was.
      env: this.configDirEnv(configDir),
    };
  }

  /**
   * Whether a failed turn's message names a cure the user can apply.
   *
   * Concrete over {@link AdapterConfig.auth}'s markers: what differs per CLI is
   * the wording, not the mechanism. Case-insensitive because a CLI is free to
   * re-case its own message between releases, and a marker that stopped
   * matching would silently take the action off the row.
   *
   * A blank marker is ignored rather than matching every message: an empty
   * substring is contained in every string, so one that reached this list would
   * offer a sign-in for every failure the CLI ever reports.
   */
  errorRecovery(message: string): AgentErrorRecovery | null {
    const haystack = message.toLowerCase();
    const { expiredMarkers } = this.getConfig().auth;
    return expiredMarkers.some(
      (marker) => marker !== '' && haystack.includes(marker.toLowerCase()),
    )
      ? 'cli-login'
      : null;
  }

  /**
   * How the user signs in to THIS CLI, or that they cannot from here.
   *
   * The sibling of {@link mcpLoginTarget} one level up: that one authenticates
   * a server the CLI loads, this one authenticates the CLI itself. A turn that
   * failed with an expired session needs the second, and offering the first
   * would send the user to a command that cannot fix what they just hit.
   *
   * `unsupported` is the only refusal — a sign-in takes no argument that could
   * be missing, so there is no `no-session` counterpart to invent.
   */
  loginTarget(configDir?: string | null): HandoffResult {
    const { loginArgs } = this.getConfig().auth;
    if (loginArgs === null) {
      return { ok: false, reason: 'unsupported' };
    }
    return {
      ok: true,
      kind: 'command',
      command: this.command,
      args: [...loginArgs],
      // The credentials live in the config directory, so a sign-in is about
      // ONE profile: without this, a user whose second-subscription chat
      // expired would sign in to their default account and watch the same
      // turn fail again.
      env: this.configDirEnv(configDir),
    };
  }

  /**
   * How the user signs OUT of this CLI, or that they cannot from here.
   *
   * The exact mirror of {@link loginTarget}, down to the single `unsupported`
   * refusal and the config-directory env — a sign-out is about one profile for
   * the same reason a sign-in is, and one that dropped the directory would clear
   * the DEFAULT account's credentials while the user was looking at a card for
   * a different profile.
   */
  logoutTarget(configDir?: string | null): HandoffResult {
    const { logoutArgs } = this.getConfig().auth;
    if (logoutArgs === null) {
      return { ok: false, reason: 'unsupported' };
    }
    return {
      ok: true,
      kind: 'command',
      command: this.command,
      args: [...logoutArgs],
      env: this.configDirEnv(configDir),
    };
  }

  /**
   * RUN this CLI's sign-in, headlessly, as a managed child — as opposed to
   * {@link loginTarget}, which only says what the invocation would be.
   *
   * Both exist on purpose. The resolve-only path is the fallback and the escape
   * hatch: it hands the user a real terminal when this one cannot finish, and it
   * is the only path for anything a daemon-owned child cannot do. This one is
   * what keeps a terminal window from opening for the common case.
   *
   * Why it is allowed at all, given the block on `loginArgs` saying the daemon
   * resolves and never runs: that block generalised a probe of `mcp login`,
   * which refuses a non-TTY stdin outright. Re-probed on claude 2.1.228 and
   * cursor-agent 2026.08.11: the ACCOUNT login does not refuse. Both print a
   * usable URL, both open the browser themselves, and cursor polls to
   * completion with stdin closed.
   *
   * `processGroup` is forced, not optional. A sign-in spawns a browser opener of
   * its own, so the thing that must die on cancel or shutdown is the GROUP —
   * `runCommand`'s execFile path would leave it behind, and that path also has
   * no writable stdin, which the code prompt needs.
   *
   * Resolves with the child's stdout when it exited cleanly, or `null` on a
   * failure or the deadline. It deliberately does NOT decide whether the user is
   * now signed in: only the CLI's own status probe can answer that, so the
   * caller re-asks rather than trusting an exit code.
   */
  runLogin(options: {
    configDir?: string | null;
    timeoutMs: number;
    onSpawn: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  }): Promise<string | null> {
    const { loginArgs } = this.getConfig().auth;
    if (loginArgs === null) {
      return Promise.resolve(null);
    }
    return this.runCommand([...loginArgs], {
      processGroup: true,
      timeoutMs: options.timeoutMs,
      env: this.configDirEnv(options.configDir),
      onSpawn: options.onSpawn,
    });
  }

  /**
   * RUN this CLI's sign-out, headlessly.
   *
   * Unlike its sign-in sibling this needs no browser and no input at all —
   * probe-verified on claude 2.1.228 with stdin closed and no TTY: exit 0,
   * "Successfully logged out from your Anthropic account." So there is nothing a
   * terminal window would add except a window.
   *
   * The plain execFile path, deliberately: clearing stored credentials forks
   * nothing, so there is no group to reap, and node's own deadline is the whole
   * story. Resolves `true` when the CLI exited cleanly.
   */
  async runLogout(options: {
    configDir?: string | null;
    timeoutMs?: number;
    onSpawn?: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  }): Promise<boolean> {
    const { logoutArgs } = this.getConfig().auth;
    if (logoutArgs === null) {
      return false;
    }
    const out = await this.runCommand([...logoutArgs], {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      env: this.configDirEnv(options.configDir),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
    });
    return out !== null;
  }

  /**
   * Whether this CLI's sign-in output is asking for a code on stdin.
   *
   * Concrete over `auth.loginCodePromptMarkers`, so the service driving a login
   * never learns which CLI prompts and which polls — a CLI that needs nothing
   * declares an empty list and this is permanently false for it.
   */
  loginWantsCode(output: string): boolean {
    const haystack = output.toLowerCase();
    return this.getConfig().auth.loginCodePromptMarkers.some(
      (marker) => marker !== '' && haystack.includes(marker.toLowerCase()),
    );
  }

  constructor(protected readonly options: AgentAdapterOptions = {}) {}

  /** Build the argv for one turn (model/resume flags, prompt when positional). */
  protected abstract buildArgs(input: AgentTurnInput): string[];

  /**
   * The models this CLI will accept for `--model`, newest information first.
   *
   * Every CLI answers this differently — one has a subcommand, another only a
   * documented alias set — so the shape is fixed here and each subclass
   * decides how to obtain it. An implementation must NEVER throw or hang: a
   * CLI that cannot be asked returns its built-in set, so the picker always
   * offers something.
   */
  abstract listModels(options?: AgentCommandOptions): Promise<AgentModel[]>;

  /**
   * The MCP servers this CLI loads in a given folder, with the health it
   * reports for each.
   *
   * CONCRETE over config, like `listSkills` and `listEfforts`: whether a CLI
   * can be listed at all is a per-CLI VALUE
   * (`config.mcp.listingUnavailableReason`), so an adapter that cannot be
   * asked declares that string and writes no code — no override, and so no
   * unreachable branch that could drift from the declaration. A CLI that CAN
   * be listed overrides this with its own mechanism.
   *
   * The default refuses rather than answering `{ ok: true, servers: [] }`,
   * because a future adapter that declares no reason and forgets to override
   * must degrade to a visible "not implemented", never to a confident "this
   * folder has no MCP servers".
   *
   * `input.cwd` is load-bearing: the answer is folder-scoped (project
   * `.mcp.json` servers, and local-scope servers keyed to that directory), so
   * a listing taken from the wrong place is confidently wrong rather than empty.
   *
   * Must NEVER throw or hang — this feeds a panel, so a CLI that is missing,
   * unauthenticated or hung costs the user a list, not the request.
   */
  listMcpServers(
    _input: AgentMcpServersInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    const config = this.getConfig();
    return Promise.resolve({
      ok: false,
      reason:
        config.mcp.listingUnavailableReason ??
        `${config.kind} does not implement MCP listing`,
    });
  }

  /**
   * What this CLI's own config files say about one folder's servers — which
   * are project-scope, and which the user has already disabled themselves.
   *
   * A MECHANISM, not a value: each CLI keeps this in different files with
   * different keys, so an adapter that knows those files overrides this. The
   * default is the honest answer for one that does not — nothing is known,
   * which renders every row read-only rather than offering a switch whose
   * effect has never been verified for that CLI.
   *
   * Reads only. The files it consults belong to the user, and nothing in this
   * feature ever writes them.
   */
  readMcpFolderFacts(_cwd: string): Promise<AgentMcpFolderFacts> {
    return Promise.resolve({ disabled: [], lockedOff: [] });
  }

  /**
   * Dial ONE server and report what the CLI said about it, or null when this
   * CLI has no way to be asked about a single one.
   *
   * The point is cost. A folder listing health-checks EVERY server — 4–9s here,
   * and it launches all of them — so it is the wrong instrument for the one
   * question that arises after a write: the user just switched a server on, and
   * the row has to say something about it. Without this the honest answer is
   * `unknown`, since nothing has dialled it (see
   * `AgentMcpService.patchCachedStatus`), and a green dot would be the panel
   * claiming a server works because a switch moved.
   *
   * The default returns null rather than guessing, on the same rule every
   * declared absence here follows: a CLI with no per-server command costs the
   * user a badge until the next real read, not a wrong one.
   *
   * Must NEVER throw — it feeds a panel, and a CLI that is missing or hung costs
   * one row's health, not the toggle the user just performed.
   */
  readMcpServerHealth(
    _input: AgentMcpServerHealthInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    return Promise.resolve(null);
  }

  /**
   * Switch one MCP server on or off for one folder — the WRITE half of
   * {@link readMcpFolderFacts}, and the same kind of thing: a mechanism only
   * that CLI knows, so an adapter that has one overrides this.
   *
   * The default REFUSES, with the config's own sentence saying why. Refusing
   * is the honest answer for a CLI whose disable mechanism is unverified: a
   * switch that moves and changes nothing is the exact failure this feature is
   * written to avoid, and the caller turns the refusal into an HTTP error the
   * panel can show.
   *
   * An adapter that implements it writes the CLI's OWN state, not a private
   * one — claude edits `projects[<cwd>].disabledMcpServers` in `~/.claude.json`
   * under the same `proper-lockfile` lock the CLI itself takes, and cursor
   * drives that CLI's own `mcp enable|disable` subcommands. That is a
   * deliberate exception to "geniro writes only its own files": it is the only
   * mechanism that reaches servers of every scope, and sharing the CLI's list
   * means a switch flipped here is the same switch the user sees in their own
   * terminal.
   *
   * `options` is here for the implementations that reach the CLI rather than a
   * file: it carries `onSpawn`, so the caller registers the child for shutdown
   * exactly as it does for {@link listMcpServers}. An implementation that only
   * edits a file ignores it.
   */
  setMcpServerEnabled(
    _cwd: string,
    _server: string,
    _enabled: boolean,
    _options: AgentCommandOptions = {},
  ): Promise<void> {
    return Promise.reject(
      new Error(
        this.getConfig().mcp.toggleUnavailableReason ??
          `${this.getConfig().kind} cannot be told which MCP servers to load`,
      ),
    );
  }

  /**
   * The reasoning-effort levels this CLI accepts for one turn, weakest first,
   * or `[]` when it has no such control at all.
   *
   * Synchronous because it is a documented constant on every adapter that has
   * one — nothing is asked of the binary. It must NOT be scraped from the
   * CLI's own help output: claude's `--help` under-reports its own vocabulary
   * (probe-verified — see `claude/claude.const.ts`), so a scrape would
   * silently drop a level the CLI accepts.
   *
   * A `config.efforts` of `[]` is the whole signal that the CLI has no effort
   * control: the consumer refuses an effort for it and the UI omits the
   * picker, without anything outside this layer knowing which CLI it is.
   */
  listEfforts(): AgentEffort[] {
    return [...this.getConfig().efforts];
  }

  /**
   * The skills / slash commands this CLI can be invoked with in a folder, as
   * found on disk — each CLI keeps them under its own roots
   * (`config.skillRoots`: `.claude/skills`, `.claude/commands`,
   * `.cursor/commands`), scanned in the project folder and then the user's
   * home dir.
   *
   * The ORDER is the contract, and it is the CLI's own shadowing order: root
   * by root, skills before commands, project before user. The caller de-dupes
   * first-occurrence-wins, so this is what makes it keep the entry the CLI
   * would actually run. Never throws — one broken file on disk must not fail
   * the list (the scanners skip unreadable entries).
   */
  async listSkills({
    cwd,
    homeDir,
  }: AgentSkillsInput): Promise<AgentSkillEntry[]> {
    const roots = [
      { source: 'project' as const, dir: cwd },
      { source: 'user' as const, dir: homeDir },
    ];
    const found: AgentSkillEntry[] = [];
    for (const { source, dir } of roots) {
      for (const segments of this.getConfig().skillRoots.skills) {
        found.push(...(await scanSkillDirs(join(dir, ...segments), source)));
      }
      for (const segments of this.getConfig().skillRoots.commands) {
        found.push(...(await scanCommandFiles(join(dir, ...segments), source)));
      }
    }
    return found;
  }

  /**
   * The slash commands the CLI ITSELF reports it can run — its built-ins and
   * plugin commands, which exist nowhere on disk to be scanned.
   *
   * Only the binary knows this set, and only some CLIs will say: a CLI that
   * makes no such report (`config.reportedCommands: null`) answers `[]` without
   * spawning anything, and so does one that cannot be asked right now. Never
   * throws, and never hangs. The caller decides how often to ask; this method
   * always does the work when called.
   *
   * The harvest itself is the same for every CLI that HAS such a report,
   * because it rides the normalized `slash_commands` event rather than any
   * CLI's own field: start one headless turn and cancel it the instant the list
   * lands, before the model runs — which is what makes the answer free.
   *
   * The turn runs in a throwaway temp cwd on purpose, on both counts: it fires
   * no project hooks and starts no session in a repo the user did not ask us to
   * touch, and the answer is CWD-INDEPENDENT — verified live against claude, an
   * empty temp dir reports the same built-ins and plugin commands as a real
   * project — so one probe serves every folder. What that necessarily excludes
   * is the per-project layer, which the disk scan (`listSkills`) already covers.
   *
   * Returns `[]` when the CLI never reached its report (missing binary, auth
   * failure, a hang).
   */
  async listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<string[]> {
    const probe = this.getConfig().reportedCommands;
    if (!probe) {
      return [];
    }
    // INSIDE the try: creating the root can fail (an unusable `probeRootDir`),
    // and that must degrade to the disk scan like every other probe failure
    // rather than throw out of a listing.
    let cwd = '';
    let captured: string[] = [];
    try {
      cwd = this.makeProbeRoot('commands');
      let resolveCaptured!: () => void;
      const commandsSeen = new Promise<void>((resolve) => {
        resolveCaptured = resolve;
      });
      // No approvalMode: the turn gets the CLI's own defaults and NO
      // permission-bypass flag. It is cancelled before the model runs, so the
      // least-privileged argv is also the sufficient one.
      //
      // `isolateMcpServers` for the same reason, one step further: the probe
      // reads a list the CLI reports about ITSELF, so no MCP server can
      // contribute to the answer — but without this the CLI still starts every
      // server the folder defines, and cancelling the probe then reaps a group
      // holding the user's own. Nothing to launch is nothing to kill.
      const handle = this.start(
        { prompt: probe.probePrompt, cwd, isolateMcpServers: true },
        (event) => {
          if (event.type === 'slash_commands' && captured.length === 0) {
            captured = event.commands
              .filter(
                (name) =>
                  probe.internalPrefix === null ||
                  !name.startsWith(probe.internalPrefix),
              )
              .slice(0, probe.maxCommands);
            resolveCaptured();
          }
        },
      );
      options.onTurn?.(handle);
      const timer = setTimeout(
        () => handle.cancel(),
        options.timeoutMs ?? probe.probeTimeoutMs,
      );
      timer.unref?.();
      const capturedWon = await Promise.race([
        commandsSeen.then(() => true),
        handle.done.then(() => false),
      ]);
      if (capturedWon) {
        // Proof is in — the rest of the turn is spent without information.
        handle.cancel();
      }
      await handle.done;
      clearTimeout(timer);
    } catch {
      // A turn that fails synchronously (an unusable probe root, a bad argv)
      // leaves the caller with the disk scan.
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
    return captured;
  }

  /**
   * A fresh empty directory to point a probe at.
   *
   * Every probe needs one for the same reason: `resolve-cwd.ts` records that an
   * agent is scoped to the user's CHOSEN folder and "never defaults to the
   * daemon's own cwd, the app repo". A probe has no chosen folder, so it gets a
   * disposable one rather than borrowing whichever directory the daemon happens
   * to be running in — which under `pnpm dev` is this repo, and would root a
   * real agent session there.
   *
   * `probeRootDir` keeps it under the app's own userData when the daemon runs
   * packaged, and falls back to the OS tmpdir for standalone and spec use.
   */
  protected makeProbeRoot(label: string): string {
    const dir = join(
      this.options.probeRootDir ?? tmpdir(),
      `${label}-${randomUUID()}`,
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Best-effort cleanup only: a straggler of a just-cancelled probe process
   * group writing into the directory can make `rmSync` throw (EBUSY/ENOTEMPTY —
   * `force` suppresses only ENOENT). That must never fail the read; the temp
   * dir is reaped on the next probe/boot.
   */
  protected removeProbeRoot(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // See the doc block above — deliberately swallowed.
    }
  }

  /** Memoized: the binary is asked once per adapter instance, not once per turn. */
  private liveStreamSupport: Promise<boolean> | null = null;

  /**
   * Whether the INSTALLED binary can stream partial assistant text, so a turn
   * may be started with `streamPartials`.
   *
   * Asked rather than assumed because the answer is per-binary, not per-CLI: a
   * flag the current claude accepts is rejected on argv by an older one, which
   * would fail every turn instead of merely not streaming. A CLI with no such
   * mode (`config.liveStream: null`) answers false forever, without spawning
   * anything.
   *
   * `config.liveStream.probeArgs` is `--help`-shaped by design: the cheapest
   * honest source, since it is the same binary that would reject the flag on
   * argv, it needs no account and no network, and it cannot start a turn.
   * Never throws — absent output (a missing binary, a timeout) reads as "no",
   * which degrades to block streaming rather than failing turns.
   */
  supportsLiveStream(options: AgentCommandOptions = {}): Promise<boolean> {
    const liveStream = this.getConfig().liveStream;
    if (!liveStream) {
      return Promise.resolve(false);
    }
    this.liveStreamSupport ??= this.runCommand(
      [...liveStream.probeArgs],
      options,
    ).then((stdout) => (stdout ?? '').includes(liveStream.flag));
    return this.liveStreamSupport;
  }

  /**
   * Run a short-lived utility command for THIS CLI and return its stdout, or
   * null if it failed, timed out, or the binary is missing.
   *
   * The single spawn path for everything that is not a turn — subclasses never
   * reach for `execFile` themselves, exactly as they never reach for
   * `runHeadlessCli`. It strips the daemon's `GENIRO_`-prefixed env like a
   * turn does, and hands the child to `onSpawn` so the caller can register it
   * for shutdown. Never rejects.
   *
   * `options.processGroup` picks WHICH of the two child shapes below runs —
   * see that option's doc block, which is the canonical statement of why.
   *
   * A CONVERSATIONAL command implies the group path rather than merely being
   * documented to require it. `execFile` gets no writable stdin here, so
   * `stdinWrites` there would drop every frame silently and `settleWhen` would
   * never be consulted — the read would then wait out its whole deadline
   * against a CLI that (for the one caller this exists for) never exits, and
   * report the failure of a read that would have succeeded. Inferring the path
   * from the options makes that combination unreachable instead of a rule a
   * caller has to remember.
   */
  protected runCommand(
    args: string[],
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    const conversational =
      options.stdinWrites !== undefined || options.settleWhen !== undefined;
    return options.processGroup === true || conversational
      ? this.runAsProcessGroup(args, options)
      : this.runViaExecFile(args, options);
  }

  /**
   * The plain path: node buffers stdout and enforces the deadline itself with
   * a single-PID kill, which is the whole story for a command that forks
   * nothing of its own.
   */
  private runViaExecFile(
    args: string[],
    options: AgentCommandOptions,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const run = this.options.execFileFn ?? execFile;
      let child: ChildProcess;
      try {
        child = run(
          this.command,
          args,
          {
            timeout: options.timeoutMs ?? UTILITY_COMMAND_TIMEOUT_MS,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            encoding: 'utf8',
            env: buildChildEnv({ ...this.inheritedEnv(), ...options.env }),
          },
          (err, stdout, stderr) =>
            resolve(
              // `captureDiagnosis` keeps the output on the FAILURE path, where
              // some CLIs put the only reading that matters — see that option.
              // Both streams, because that is where they put it.
              options.captureDiagnosis === true
                ? `${String(stdout)}${String(stderr)}`
                : err
                  ? null
                  : String(stdout),
            ),
        );
      } catch {
        // A missing binary throws synchronously on some platforms.
        resolve(null);
        return;
      }
      options.onSpawn?.(child, { processGroup: false });
    });
  }

  /**
   * The group path: `spawn` with `detached`, stdout collected by hand, and a
   * deadline of our own that reaps the WHOLE group.
   *
   * It cannot be `execFile` carrying `detached: true` in its options bag:
   * node forwards only cwd/env/uid/gid/shell/windows* from `execFile` down to
   * `spawn` and silently drops the rest, so such a child never leads a group
   * and `killProcessGroup(child.pid)` names a pgid that does not exist.
   *
   * Both streams are handled explicitly, because `execFile` did it for us and
   * `spawn` does not: stdout is DECODED AS A STREAM (`setEncoding`, so a
   * multi-byte character split across two reads survives), and stderr is
   * DRAINED. An unread stderr pipe fills at ~64KB and blocks the child
   * mid-write, so a listing whose answer was already on the wire would hang
   * to the deadline and report as a failure.
   *
   * Reaps on EVERY settle, success included, and that is not symmetry for its
   * own sake. A listing command HEALTH-CHECKS — it launches the user's own MCP
   * servers to dial them — and a server that does not exit on stdin EOF
   * outlives the CLI. Probed on cursor-agent 2026.07.23-e383d2b with a
   * deliberately lingering stdio server: `mcp list` exited 0 and left exactly
   * one child running. Once the CLI exits `ProcessRegistry` drops the handle
   * on `done`, so nothing else could ever reach that group again — not
   * shutdown, not cancel — and each refresh stranded another copy.
   */
  private runAsProcessGroup(
    args: string[],
    options: AgentCommandOptions,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const spawnFn = this.options.groupSpawnFn ?? spawn;
      const timeoutMs = options.timeoutMs ?? UTILITY_COMMAND_TIMEOUT_MS;
      let child: ChildProcess | undefined;
      let settled = false;
      let reaped = false;
      let stdout = '';
      /**
       * Collected only under `captureDiagnosis`, and appended to `stdout` at
       * settle. Kept separate while reading so an interleaved write cannot land
       * in the middle of a stdout line the parser is about to split.
       */
      let stderr = '';
      const reapGroup = (): void => {
        // Idempotent, and that is the point: `exit`, `close` and the deadline
        // all reap. Without this the second signal would land after node has
        // waitpid'd the child, when the pid may already belong to something
        // else.
        // `child` is assigned before any caller of this can run: the stream
        // and process listeners are attached after the spawn, and the timer
        // cannot fire synchronously. The guard is the type narrowing.
        if (reaped || !child) {
          return;
        }
        reaped = true;
        // SIGTERM first, then SIGKILL. This group exists to have launched the
        // user's OWN MCP servers — that is what a listing command does to
        // health-check them — and a server holding real state (a browser
        // session, an open index) needs the chance to shut down.
        //
        // The escalation runs even once the CLI's own `exit` has been seen,
        // because the wedged case this reap exists for HAS an exit: the CLI is
        // gone while a health-check grandchild still holds the inherited stdout
        // pipe, so `close` never arrives, and it is the SIGKILL that closes the
        // pipe and lets an already-read listing be delivered. Withholding it
        // there trades a working read for the deadline and a null.
        //
        // Safe despite the pid-reuse hazard, by POSIX: a process-GROUP id is
        // not reissued while the group still has members, so `kill(-pgid)`
        // reaches something only when that something is genuinely this group.
        // Once the group is empty the signal finds nothing.
        createGroupTerminator(child).terminate();
      };
      const settle = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // Armed BEFORE the spawn: an injected spawn that emits synchronously
      // (the spec seam) would otherwise leave a live timer no listener can
      // clear, and it would fire `killProcessGroup` on a pid the test invented.
      const timer = setTimeout(() => {
        reapGroup();
        settle(null);
      }, timeoutMs);
      timer.unref?.();
      try {
        child = spawnFn(this.command, args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildChildEnv({ ...this.inheritedEnv(), ...options.env }),
        });
      } catch {
        // A missing binary throws synchronously on some platforms.
        settle(null);
        return;
      }
      // Journaled like a turn spawn, and for a sharper reason: this path is
      // taken by `mcp list`, which HEALTH-CHECKS by launching the user's own
      // MCP servers (see the doc block above). A SIGKILL between the spawn and
      // the reap strands that whole group with nothing left to name it.
      trackDetachedChild(child, this.command);
      if (options.stdinWrites !== undefined) {
        // Attached BEFORE the first write. An `'error'` on a stream with no
        // listener is an uncaught exception in node, and `child.on('error')`
        // below does NOT cover it — that one is the ChildProcess's own error,
        // while this is the stdin socket's. The reachable case is ordinary: a
        // missing binary fails the spawn asynchronously, or the child exits
        // before the buffered frames flush, and either raises EPIPE /
        // ERR_STREAM_DESTROYED here. Without this, opening the model picker on
        // a machine with no working CLI would take the daemon down instead of
        // answering with an empty list.
        child.stdin?.on('error', () => {
          reapGroup();
          settle(null);
        });
        for (const chunk of options.stdinWrites) {
          child.stdin?.write(chunk);
        }
      }
      // Decoded as a STREAM: node's StringDecoder holds a partial multi-byte
      // sequence across reads, so a character split at a 64KB boundary is not
      // turned into two replacement characters.
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        // A settled read still has a live pipe until `close`. Without this the
        // buffer would go on growing past the cap that just gave up on it —
        // for a deadline settle, until the child is reaped.
        if (settled) {
          return;
        }
        stdout += chunk;
        // Checked BEFORE the size cap: a conversational command's answer is
        // already complete here, and this path exists because its child will
        // never exit on its own to end the read.
        if (options.settleWhen?.(stdout) === true) {
          reapGroup();
          settle(stdout);
          return;
        }
        if (stdout.length > UTILITY_COMMAND_MAX_BUFFER_CHARS) {
          // `execFile`'s own maxBuffer path kills the direct pid only; ours
          // reaps the group, or the grandchildren outlive the read that gave
          // up on them.
          reapGroup();
          settle(null);
        }
      });
      // DRAINED at minimum, and that is not optional: a piped stream with no
      // reader fills at ~64KB and the child blocks mid-write, so `close` never
      // arrives. `mcp list` health-checks the user's own MCP servers and
      // forwards their startup noise down exactly this pipe.
      //
      // Under `captureDiagnosis` it is drained by being COLLECTED, which is the
      // same obligation met a different way — the stream is still consumed on
      // every chunk. Capped like stdout, and by the SAME budget rather than its
      // own: an MCP server's startup noise arrives here, so a chatty one must
      // not be able to push the read past the cap that protects the daemon's
      // memory and then have its own diagnosis truncated instead.
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (settled || options.captureDiagnosis !== true) {
          return;
        }
        stderr += chunk;
        if (stdout.length + stderr.length > UTILITY_COMMAND_MAX_BUFFER_CHARS) {
          reapGroup();
          settle(null);
        }
      });
      child.on('error', () => {
        reapGroup();
        settle(null);
      });
      // `exit` fires when the CLI itself is gone; `close` waits for the stdio
      // pipes, which a lingering health-check grandchild holds open. Reaping
      // at `exit` is what lets `close` arrive at all in that case — otherwise
      // the read that DID succeed sits until the deadline and reports null.
      child.on('exit', () => reapGroup());
      child.on('close', (code, signal) => {
        reapGroup();
        if (options.captureDiagnosis === true) {
          // The exit status is deliberately not consulted: the caller asked for
          // the output BECAUSE the reading it wants comes with a non-zero exit.
          settle(`${stdout}${stderr}`);
          return;
        }
        settle(code === 0 && signal === null ? stdout : null);
      });
      options.onSpawn?.(child, { processGroup: true });
    });
  }

  /** Map one parsed line of the CLI's stream-json output to normalized events. */
  protected abstract mapMessage(obj: unknown): AgentEvent[];

  /**
   * The full instruction text for one turn: the node's role, then the caller's
   * "May call" block — but the latter ONLY when this turn actually registered
   * the call tools.
   *
   * This lives on the base because getting it wrong is silent: an agent told
   * to route work through `call_agent` with no such tool registered never runs
   * its callees, and the node still reports success. Each adapter knows its
   * own delivery mechanism, so it passes `granted`; nobody re-derives the
   * join. Adapters compose the result differently — claude appends it via
   * `--append-system-prompt`, ACP prepends it to the prompt text — but the
   * rule about WHEN the block is included is the same for every CLI.
   */
  protected composeSystemPrompt(
    input: AgentTurnInput,
    granted: boolean,
  ): string {
    return [input.systemPrompt, granted ? input.callSurfacePrompt : null]
      .filter((part): part is string => Boolean(part))
      .join('\n\n');
  }

  /**
   * Payload written to the child's stdin before it is closed. The default —
   * no payload — closes stdin immediately, so a CLI that reads its prompt from
   * argv never blocks waiting on stdin (and an unauthenticated CLI fails fast
   * instead of dropping into an interactive login TTY).
   */
  protected buildStdinPayload(_input: AgentTurnInput): string | undefined {
    return undefined;
  }

  /**
   * Extra environment merged over the stripped child env. The default passes
   * through the caller's `input.env`; an adapter whose CLI needs a secret
   * re-injects it here for its OWN child only (see `CursorAcpAdapter`).
   */
  protected buildEnv(
    input: AgentTurnInput,
  ): Record<string, string> | undefined {
    return input.env;
  }

  /**
   * Whichever of this CLI's {@link AdapterConfig.auth.inheritedEnvKeys} the
   * daemon itself actually has — the credentials `buildChildEnv` strips from
   * every child, put back for the one entitled to them.
   *
   * CONCRETE over config, with no overrides, because the entitlement is data and
   * this is the ONE place that reads it. That is what keeps the turn path and the
   * utility path from disagreeing again: they call this, not their own copies.
   * See the field's own doc for the divergence it replaced.
   */
  protected inheritedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of this.getConfig().auth.inheritedEnvKeys) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
    return env;
  }

  /**
   * Whether the child's stdin stays open past the payload for a mid-turn
   * dialogue. Default false (stdin closes immediately); the Claude adapter
   * returns true in `ask` approval mode for its control protocol.
   */
  protected keepStdinOpen(_input: AgentTurnInput): boolean {
    return false;
  }

  /**
   * Encode one approval verdict as the stdin line the CLI expects. Default
   * undefined — no approval protocol; `respondApproval` is then a no-op.
   */
  /**
   * Build this turn's protocol driver. The default is stateless — it forwards
   * each line to {@link mapMessage} and each verdict to
   * {@link buildApprovalResponse}, which is the whole protocol for a one-shot
   * stream-json CLI. Override when the CLI speaks a stateful, bidirectional
   * protocol whose state must be per-turn (see `AcpTurnDriver`): one adapter
   * instance drives N concurrent turns under graph fan-out, so that state can
   * never live on the adapter itself.
   */
  protected createTurnDriver(_input: AgentTurnInput): TurnDriver {
    return {
      onMessage: (obj) => this.mapMessage(obj),
      buildApprovalResponse: (id, allow, updatedInput) =>
        this.buildApprovalResponse(id, allow, updatedInput),
    };
  }

  protected buildApprovalResponse(
    _id: string,
    _allow: boolean,
    _updatedInput?: unknown,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode a mid-turn approval-mode change for a turn THIS adapter spawned,
   * or undefined when that turn cannot be re-moded.
   *
   * Takes the turn's own `input` rather than being a per-CLI constant, because
   * the answer is per-TURN: claude can be re-moded on the stdio permission
   * dialogue, but a turn it spawned under `--dangerously-skip-permissions` has
   * no prompt tool wired, and no message can reintroduce a gate the process
   * was started without. Stateless by construction — a pure function of
   * (input, mode) — so it stays on the adapter while genuine protocol state
   * lives on the per-turn driver.
   *
   * The default is the "this CLI cannot be told" answer, which is the honest
   * one for ACP: `session/set_mode` is a session-level call, not something the
   * protocol accepts against a prompt already in flight.
   */
  protected buildApprovalModePayload(
    _input: AgentTurnInput,
    _mode: AgentApprovalMode,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode a user message sent while the turn is STILL RUNNING, as the stdin
   * line this CLI expects. Default undefined — "this CLI cannot be told
   * anything more once its prompt is in", which makes
   * `AgentTurnHandle.sendUserMessage` return false and leaves the caller to
   * queue the message for the next turn.
   *
   * It is a MECHANISM rather than a config value: the payload is this CLI's
   * own wire shape, the same reason `buildApprovalResponse` is a method. An
   * adapter that overrides it must also keep stdin open for the turn
   * (`keepStdinOpen`), or the line has nowhere to go.
   */
  protected buildFollowUpPayload(
    _message: FollowUpMessage,
  ): string | undefined {
    return undefined;
  }

  /**
   * Whether a process spawned for this turn should be KEPT so the run's next
   * turn can use it, instead of dying with the turn.
   *
   * The spawn-time question, asked once; {@link buildNextTurnPayload} is the
   * per-turn mechanism that then opens each subsequent turn. Default false —
   * "this CLI needs a fresh process per turn", which is what every adapter
   * did before run-scoped sessions and remains correct for any CLI whose
   * stdin cannot carry a second prompt.
   *
   * An adapter answering true MUST also keep stdin open for the whole session
   * and implement `buildNextTurnPayload`, or the process is kept alive with no
   * way to ever talk to it again.
   */
  protected canHostSession(_input: AgentTurnInput): boolean {
    return false;
  }

  /**
   * Encode the payload that opens ANOTHER turn on a process that has already
   * finished one. Undefined = there is no such payload and the caller must
   * spawn afresh.
   *
   * Deliberately NOT the same hook as {@link buildFollowUpPayload}, even where
   * one CLI's bytes happen to be identical: that one adds to a prompt already
   * in flight, this one starts the next prompt. The two come apart on the very
   * next transport — ACP HAS a next prompt (`session/prompt` again on the same
   * session) and has no way at all to add to one already accepted — so
   * collapsing them would make that adapter unimplementable without an
   * untangle.
   */
  protected buildNextTurnPayload(
    _message: FollowUpMessage,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode an in-protocol "stop the current turn" for this CLI. Undefined =
   * this CLI has no such message and can only be stopped by killing it.
   *
   * Only reached on a run-scoped session, where the difference is the whole
   * point: killing the group takes the user's MCP servers — and a browser one
   * of them owns — down with a turn they only meant to stop.
   */
  protected buildInterruptPayload(_input: AgentTurnInput): string | undefined {
    return undefined;
  }

  /**
   * The fingerprint of everything this turn baked into the child's argv and
   * env. Two turns with the same key can share one process; a change means
   * the running process cannot serve the new turn and must be replaced.
   *
   * Concrete on the base rather than per-adapter: it is composed of the INPUT
   * fields a `buildArgs` can read, not of any one CLI's flags, so an adapter
   * that starts reading a new field is the only reason to override it.
   *
   * Four fields are deliberately absent:
   *
   * - `prompt` / `images` — per-turn by definition; they ride stdin, not argv.
   * - `resumeSessionId` — a continued turn must NOT resume, because the
   *   process already holds the session. Keying on it would make every second
   *   turn look like a different process.
   * - `approvalMode` — a live process is RE-MODED rather than respawned, so a
   *   change here is delivered on the way into the next turn (see
   *   `startSession`'s `startTurn`, which is what makes this omission safe);
   *   the session falls back to a respawn only when the running process
   *   refuses, which is the honest signal that it was spawned in a shape no
   *   message can change.
   */
  protected sessionKey(input: AgentTurnInput): string {
    return JSON.stringify([
      this.getConfig().kind,
      this.command,
      input.cwd,
      input.model ?? null,
      input.effort ?? null,
      input.systemPrompt ?? null,
      input.callSurfacePrompt ?? null,
      input.configDir ?? null,
      input.streamPartials === true,
      input.allowUserQuestions === true,
      input.trustWorkspace === true,
      // Read by `buildArgs`, so it is argv, so it belongs here — a turn that
      // isolated its MCP set cannot be served by a process spawned without
      // that restriction, or the reverse.
      input.isolateMcpServers === true,
      input.mcpEndpoint?.url ?? null,
      input.env ?? null,
    ]);
  }

  /**
   * Materialize turn-scoped resources BEFORE the spawn; the returned disposer
   * runs when the turn settles (any path). Default: nothing. The Claude
   * adapter writes its per-turn MCP config file here so `buildArgs` can
   * reference the path while the call token stays out of argv.
   */
  protected prepareTurn(_input: AgentTurnInput): (() => void) | undefined {
    return undefined;
  }

  /**
   * What this CLI says its context window currently holds, or null when it has
   * no way to say.
   *
   * PUBLIC, and a method with one implementation per adapter — the mechanism is
   * deliberately not presupposed. Two earlier drafts of this seam each baked in
   * one CLI's shape and would have made the other unimplementable: asking the
   * adapter for a request LINE assumed the answer comes back over stdin (it is
   * claude's shape), and hanging it off the live session assumed a process
   * exists to ask (cursor's does not outlive its turn — its figures are on
   * disk). {@link AgentContextUsageInput} therefore offers BOTH channels and
   * each adapter takes what it needs.
   *
   * The VALUE half is `AdapterConfig.usage.breakdownUnavailableReason`: what to
   * tell the user when this returns null. The two must agree, and
   * `agent-adapter.spec.ts` pins that they do.
   */
  readContextUsage(
    _input: AgentContextUsageInput,
  ): Promise<AgentContextUsage | null> {
    return Promise.resolve(null);
  }

  /**
   * Open a CLI process for this run and return the session that owns it.
   *
   * The single spawn path. A CLI that answers false to {@link canHostSession}
   * yields a session serving exactly one turn — which is what every caller got
   * before run-scoped sessions existed, reached now through the same code
   * rather than a branch.
   *
   * **The caller owns the process.** Nothing here reaps a run-scoped session;
   * it lives until someone calls `close()`. That is why `runScoped` is the
   * CALLER's opt-in and not the adapter's decision alone: `canHostSession`
   * answers whether this CLI *can* be kept, while only a caller holding a run
   * to keep it for can answer whether it *should* be — and a caller with
   * nowhere to store the session would otherwise leak a process per turn.
   */
  startSession(
    input: AgentTurnInput,
    opts: {
      runScoped?: boolean;
      betweenTurnApproval?: BetweenTurnApproval | undefined;
      onBetweenTurnEvent?: (event: AgentEvent) => void;
    } = {},
  ): AgentSession {
    const runScoped = opts.runScoped === true && this.canHostSession(input);
    // Turn-scoped resources become SESSION-scoped once the process outlives
    // the turn: claude's `--mcp-config` file is named in argv, so it has to
    // outlive every turn that argv serves. For a one-turn session the two are
    // the same moment (the process ends with the turn), so this is not a
    // behaviour change for any existing caller.
    const dispose = this.prepareTurn(input);
    const key = this.sessionKey(input);
    // The mode this process was SPAWNED with, tracked because `sessionKey`
    // deliberately omits it: the mode is baked into argv, so a later turn
    // asking for a different one is served by re-moding the live process
    // rather than replacing it. Without this the key's omission would mean the
    // new mode is simply never applied — the run row and the chip would both
    // read a posture the CLI was never told about.
    let spawnedMode = input.approvalMode;
    let session: CliSession;
    let driver: TurnDriver;
    try {
      // Resolved once, INSIDE the try: `command` re-reads the binary override
      // per access, and a `buildArgs` throw must still reach the disposer
      // below — hoisting either one out would leak the session-scoped resource.
      const command = this.command;
      const args = this.buildArgs(input);
      driver = this.createTurnDriver(input);
      session = runCliSession({
        command,
        args,
        cwd: input.cwd,
        env: this.buildEnv(input),
        stdinLifetime: runScoped
          ? 'session'
          : this.keepStdinOpen(input)
            ? 'turn'
            : 'payload',
        mapper: (obj) => driver.onMessage(obj),
        spawn: this.options.spawn,
        logger: this.options.logger,
        questionToolName: this.getConfig().questionToolName,
        // Passed straight through: what to answer between turns depends on the
        // run's approval posture, which the CALLER holds — an adapter deciding
        // it here would be a third copy of approval semantics that already
        // live in the chat service and the graph executor.
        betweenTurnApproval: opts.betweenTurnApproval,
        onBetweenTurnEvent: opts.onBetweenTurnEvent,
      });
    } catch (err) {
      // A synchronous throw between prepareTurn and a live session (a bad
      // argv) would otherwise leak the session-scoped resource — the disposer
      // only rides `closed`, which never arrives here. Its own failure must
      // not mask the original error.
      this.runDisposer(dispose);
      throw err;
    }
    if (dispose) {
      // `closed` never rejects, so one callback covers every exit path. The
      // disposer itself may throw (an rmSync EACCES) — that's cleanup failure
      // to log, not an unhandled rejection.
      void session.closed.then(() => this.runDisposer(dispose));
    }

    let firstTurnTaken = false;
    return {
      // The out-of-band question channel, forwarded as-is: an adapter that
      // answers from its running process reaches it through here.
      ask: (request) => session.ask(request),
      startTurn: (turnInput, onEvent) => {
        // A turn needing different argv cannot run on this process, whatever
        // its stdin can carry. Checked before anything is written, so the
        // caller gets the same null it gets for a dead session.
        if (firstTurnTaken && this.sessionKey(turnInput) !== key) {
          return null;
        }
        // The opening payload differs by position, not by content: the FIRST
        // turn's rides the spawn (or is written by a driver that opens its own
        // conversation), while a later one has to say "here is the next
        // prompt" on a stdin that is already mid-conversation.
        const stdinPayload = firstTurnTaken
          ? this.buildNextTurnPayload({
              text: turnInput.prompt,
              images: turnInput.images,
            })
          : this.buildStdinPayload(turnInput);
        if (firstTurnTaken && stdinPayload === undefined) {
          return null;
        }
        // The approval mode is argv, and argv belongs to the spawn — so a turn
        // wanting a different one has to say so before its prompt, or the CLI
        // runs it under the posture the PREVIOUS turn was started with. That is
        // a safety property, not a preference: a chat switched from
        // `acceptEdits` back to `ask` between turns would go on editing files
        // without raising a single permission request, while both the chip and
        // the persisted run row read `ask`.
        //
        // Returning null when the CLI has no such message is the honest answer
        // and the one the registry already handles — it closes the session and
        // respawns, which puts the mode back in argv where it started.
        let modeLine = '';
        if (firstTurnTaken && turnInput.approvalMode !== spawnedMode) {
          if (turnInput.approvalMode === undefined) {
            // "No mode at all" is the CLI's own default, which no message can
            // ask a running process to return to.
            return null;
          }
          const line = this.buildApprovalModePayload(
            turnInput,
            turnInput.approvalMode,
          );
          if (line === undefined) {
            return null;
          }
          modeLine = line;
        }
        const handle = session.startTurn({
          // Both are newline-delimited lines on the one stdin conversation, so
          // prepending is what puts the mode change strictly ahead of the
          // prompt it has to govern. `stdinPayload` is always defined where a
          // mode line exists — a continued turn with none returned null above.
          stdinPayload: modeLine
            ? `${modeLine}${stdinPayload ?? ''}`
            : stdinPayload,
          buildApprovalResponse: (id, allow, updatedInput) =>
            driver.buildApprovalResponse?.(id, allow, updatedInput),
          buildFollowUpPayload: (message) => this.buildFollowUpPayload(message),
          buildApprovalModePayload: (mode) => {
            const line = this.buildApprovalModePayload(turnInput, mode);
            if (line !== undefined) {
              // The MID-TURN re-mode goes through here (`ChatService`'s live
              // apply), and it changes the same process state the between-turns
              // delivery above compares against. Without this the process is
              // left holding `mode` while `spawnedMode` still reads whatever it
              // was spawned with — so a later turn asking for that older mode
              // sees "no change" and sends nothing, and the CLI keeps the
              // mid-turn one. Switching to `acceptEdits` mid-turn and back to
              // `ask` afterwards would then run the next turn un-gated with
              // the chip and the run row both reading `ask`.
              spawnedMode = mode;
            }
            return line;
          },
          buildInterruptPayload: () => this.buildInterruptPayload(turnInput),
          // Both are FIRST-turn only, and for the same reason: a handshake and
          // a readiness wait belong to the PROCESS, not to each prompt. By the
          // second turn the CLI has been up for a whole turn's worth of time,
          // so re-asking would be a delay that could never find anything.
          holdPrompt: firstTurnTaken
            ? undefined
            : driver.awaitPromptReady?.bind(driver),
          onStdinReady: firstTurnTaken
            ? undefined
            : (io) => driver.onStdinReady?.(io),
          // The mappers are pure module-scope functions, so a control message
          // an adapter does not model comes back as data and is logged HERE —
          // the one caller of `mapMessage`, rather than once per consumer. It
          // is diagnostic, so it stops here and never reaches the turn.
          onEvent: (event) => {
            if (event.type === 'unhandled_control') {
              this.options.logger?.warn(
                `${this.getConfig().kind}: unmodelled control_request subtype '${event.subtype}' — dropped`,
              );
              return;
            }
            if (event.type === 'error' && event.recovery === undefined) {
              // Stamped HERE because this is the one seam every error event of
              // every adapter passes through — a mapper, a driver, a non-zero
              // exit and a stderr tail all arrive as one. Classifying at each
              // producer instead would leave whichever one was missed as the
              // only failure with no way out of it.
              onEvent({
                ...event,
                recovery: this.errorRecovery(event.message) ?? undefined,
              });
              return;
            }
            onEvent(event);
          },
        });
        if (handle) {
          firstTurnTaken = true;
          // Only once the write actually went out: a refused turn leaves the
          // process on the mode it still has, and recording the new one here
          // would make the NEXT turn skip a delivery that never happened.
          spawnedMode = turnInput.approvalMode;
        }
        return handle;
      },
      get idle() {
        // A one-turn session is never idle again once its turn has been taken:
        // the process is alive only until that turn ends, and offering it as
        // reusable would have the caller wait for a turn it can never open.
        return session.idle && (runScoped || !firstTurnTaken);
      },
      get alive() {
        return session.alive;
      },
      get retired() {
        // Forwarded, not recomputed: the state lives in the process wrapper
        // (a cancelled turn may still be printing), and the registry's eviction
        // scan is the reader. A wrapper that dropped it would leave that scan
        // treating an unusable process as the freshest reusable one.
        return session.retired;
      },
      close: () => session.close(),
      closed: session.closed,
    };
  }

  /**
   * Start a turn on its own process — the one-shot form, for a caller with no
   * run to keep a session for. Events are delivered to `onEvent` in stream
   * order; the returned handle settles via `done` and can `cancel` the turn.
   */
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle {
    const handle = this.startSession(input).startTurn(input, onEvent);
    // A fresh session always accepts its first turn; a spawn failure comes
    // back as a settled handle carrying an `error` event, not as null.
    if (!handle) {
      throw new Error(`failed to open a turn on ${this.command}`);
    }
    return handle;
  }

  /** Run a session's cleanup, logging rather than throwing on its failure. */
  private runDisposer(dispose: (() => void) | undefined): void {
    if (!dispose) {
      return;
    }
    try {
      dispose();
    } catch (err) {
      this.options.logger?.warn(
        `turn resource disposer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
