import { type ChildProcess, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveAgentBinary } from '../utils/agent-binary';
import { buildChildEnv } from '../utils/child-env';
import { killProcessGroup } from '../utils/kill-tree';
import { runHeadlessCli, type SpawnFn } from '../utils/spawn-cli';
import type {
  AdapterConfig,
  AdapterQuestion,
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEffort,
  AgentEvent,
  AgentMcpListingResult,
  AgentMcpServersInput,
  AgentModel,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
  InstalledApprovalSupport,
  InstalledCapabilities,
  TerminalCommandResult,
  TurnDriver,
} from './adapter.types';
import { scanCommandFiles, scanSkillDirs } from './utils/skill-scan.utils';

/** Utility commands (`models`, `--version`) answer fast or not at all. */
const UTILITY_COMMAND_TIMEOUT_MS = 10_000;

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
   * A plain `{ warn }` double is the whole contract: every base-class
   * diagnostic is a warning.
   */
  logger?: {
    warn(message: string): void;
  };
  /** Replacement execFile for the utility commands in tests; defaults to node's. */
  execFileFn?: typeof execFile;
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
  terminalCommand(sessionId: string | null): TerminalCommandResult {
    const terminal = this.getConfig().terminal;
    if (!terminal) {
      return { ok: false, reason: 'unsupported' };
    }
    const trimmed = sessionId?.trim();
    if (!trimmed || !terminal.sessionIdPattern.test(trimmed)) {
      return { ok: false, reason: 'no-session' };
    }
    return {
      ok: true,
      command: this.command,
      args: [terminal.resumeFlag, trimmed],
    };
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
    const cwd = join(
      this.options.probeRootDir ?? tmpdir(),
      `commands-${randomUUID()}`,
    );
    let captured: string[] = [];
    try {
      mkdirSync(cwd, { recursive: true });
      let resolveCaptured!: () => void;
      const commandsSeen = new Promise<void>((resolve) => {
        resolveCaptured = resolve;
      });
      // No approvalMode: the turn gets the CLI's own defaults and NO
      // permission-bypass flag. It is cancelled before the model runs, so the
      // least-privileged argv is also the sufficient one.
      const handle = this.start({ prompt: probe.probePrompt, cwd }, (event) => {
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
      });
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
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only: a straggler of the just-cancelled probe
        // process group writing into `cwd` can make rmSync throw
        // (EBUSY/ENOTEMPTY — `force` suppresses only ENOENT). That must never
        // fail the read; the temp dir is reaped on the next probe/boot.
      }
    }
    return captured;
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
   * `options.processGroup` changes HOW the deadline kills — see that option's
   * doc block, which is the canonical statement. The three rules it imposes
   * here: the deadline is ours rather than `execFile`'s, it SETTLES the promise
   * as well as killing (a grandchild holding the inherited stdout pipe open
   * means `execFile`'s callback never fires at all), and every abnormal exit
   * reaps the group — including `execFile`'s own `maxBuffer` path, which kills
   * the direct pid only and would otherwise leave the grandchildren with
   * nothing left to reap them.
   */
  protected runCommand(
    args: string[],
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const run = this.options.execFileFn ?? execFile;
      const timeoutMs = options.timeoutMs ?? UTILITY_COMMAND_TIMEOUT_MS;
      const group = options.processGroup === true;
      let child: ChildProcess | undefined;
      let settled = false;
      // A reap asked for before `run()` has returned — the child exists, but
      // this scope has not been handed it yet. Deferring rather than dropping
      // it keeps the reap independent of whether the exec callback happens to
      // be async (node's is; an injected one need not be).
      let reapWhenSpawned = false;
      let reaped = false;
      const reapGroup = (): void => {
        // Idempotent, and that is the point: the deadline reaps and settles,
        // and the exec callback then runs its own error-path reap. Without
        // this the second `process.kill(-pid)` lands after node has waitpid'd
        // the child, when the pid may already belong to something else.
        if (reaped) {
          return;
        }
        if (!child) {
          reapWhenSpawned = true;
          return;
        }
        reaped = true;
        const target = child;
        killProcessGroup(target.pid, 'SIGKILL', () => target.kill('SIGKILL'));
      };
      // Armed BEFORE the spawn: an `execFileFn` that calls back synchronously
      // (the spec seam) would otherwise leave a live timer no callback can
      // clear, and it would fire `killProcessGroup` on a pid the test invented.
      const timer = group
        ? setTimeout(() => {
            reapGroup();
            settle(null);
          }, timeoutMs)
        : undefined;
      timer?.unref?.();
      function settle(value: string | null): void {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(value);
      }
      try {
        child = run(
          this.command,
          args,
          {
            // A group spawn owns its own deadline above — leaving execFile's
            // in place too would fire a single-PID kill first.
            ...(group ? {} : { timeout: timeoutMs }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            ...(group ? { detached: true } : {}),
            encoding: 'utf8',
            env: buildChildEnv(),
          },
          (err, stdout) => {
            if (group && err) {
              // execFile killed the direct pid (maxBuffer, its own signal) —
              // the group it led is still standing.
              reapGroup();
            }
            settle(err ? null : String(stdout));
          },
        );
      } catch {
        // A missing binary throws synchronously on some platforms.
        settle(null);
        return;
      }
      if (reapWhenSpawned) {
        reapGroup();
      }
      options.onSpawn?.(child, { processGroup: group });
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
   * Materialize turn-scoped resources BEFORE the spawn; the returned disposer
   * runs when the turn settles (any path). Default: nothing. The Claude
   * adapter writes its per-turn MCP config file here so `buildArgs` can
   * reference the path while the call token stays out of argv.
   */
  protected prepareTurn(_input: AgentTurnInput): (() => void) | undefined {
    return undefined;
  }

  /**
   * Start a turn. Events are delivered to `onEvent` in stream order. The
   * returned handle settles via `done` and can `cancel` the turn.
   */
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle {
    const dispose = this.prepareTurn(input);
    let handle: AgentTurnHandle;
    try {
      const driver = this.createTurnDriver(input);
      handle = runHeadlessCli({
        command: this.command,
        args: this.buildArgs(input),
        cwd: input.cwd,
        env: this.buildEnv(input),
        stdinPayload: this.buildStdinPayload(input),
        keepStdinOpen: this.keepStdinOpen(input),
        buildApprovalResponse: (id, allow, updatedInput) =>
          driver.buildApprovalResponse?.(id, allow, updatedInput),
        mapper: (obj) => driver.onMessage(obj),
        onStdinReady: (io) => driver.onStdinReady?.(io),
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
          onEvent(event);
        },
        spawn: this.options.spawn,
        logger: this.options.logger,
      });
    } catch (err) {
      // A synchronous throw between prepareTurn and a settling handle (a spawn
      // failure, a bad argv) would otherwise leak the turn-scoped resource —
      // the disposer only rides `handle.done`, which never arrives here. Its
      // own failure must not mask the original error.
      try {
        dispose?.();
      } catch (disposeErr) {
        this.options.logger?.warn(
          `turn resource disposer failed: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}`,
        );
      }
      throw err;
    }
    if (dispose) {
      // `done` never rejects (handle contract), so one settle callback covers
      // every exit path. The disposer itself may throw (an rmSync EACCES) —
      // that's cleanup failure to log, not an unhandled rejection.
      void handle.done.then(() => {
        try {
          dispose();
        } catch (err) {
          this.options.logger?.warn(
            `turn resource disposer failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
    return handle;
  }
}
