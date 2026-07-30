import { type ChildProcess, execFile } from 'node:child_process';

import type { AgentKind } from '../../runs/runs.types';
import { buildChildEnv } from '../utils/child-env';
import { runHeadlessCli, type SpawnFn } from '../utils/spawn-cli';
import type {
  AgentApprovalMode,
  AgentCommandOptions,
  AgentEffort,
  AgentEvent,
  AgentModel,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
  InstalledApprovalSupport,
  InstalledCapabilities,
} from './adapter.types';

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
   * unmodelled control subtypes, an unverified CLI version. Defaults to
   * silent, so production wiring MUST pass a real one (`agents.module.ts`).
   * `error` is optional: a plain `{ warn }` test double stays valid, and
   * callers fall back to `warn` when it is absent.
   */
  logger?: {
    warn(message: string): void;
    error?(message: string): void;
  };
  /** Replacement execFile for the utility commands in tests; defaults to node's. */
  execFileFn?: typeof execFile;
  /**
   * Sink for utility children an adapter spawns on its OWN initiative rather
   * than on a caller's — today the `--version` probe behind the control
   * protocol check. Every other utility child is started through a service
   * that passes its own `onSpawn`; these have no such caller, and the
   * "every spawned child registers with ProcessRegistry" rule has no
   * short-lived exemption, so `agents.module.ts` wires this to the registry.
   */
  onUtilitySpawn?: (child: ChildProcess) => void;
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
  /** The agent this adapter drives (`claude` / `cursor-agent`). */
  abstract readonly kind: AgentKind;
  /** The CLI binary invoked for each turn. */
  protected abstract readonly command: string;

  /**
   * The tool this CLI uses to ask the USER a question, or `null` when it has
   * no question channel at all.
   *
   * It is the ONE thing that separates a genuine question from a permission
   * check on the approval path, and only the adapter knows the name — so no
   * service, executor or util may spell a tool name itself. A CLI that returns
   * null simply never produces a question, and every consumer degrades to
   * "permission only" without branching on which CLI it is.
   */
  abstract readonly questionToolName: string | null;

  /**
   * The approval modes this CLI honours at all, as a user-visible choice.
   *
   * A mode outside this list is refused where the choice is MADE (chat
   * create/patch), so the user is told no rather than handed a control that
   * silently does nothing. A CLI with no approval channel lists only the mode
   * it effectively always runs — see `CursorAdapter`.
   */
  abstract readonly approvalModes: readonly AgentApprovalMode[];

  /**
   * The subset of {@link approvalModes} whose support cannot be known from the
   * CLI's name alone and must be PROVED against the installed binary.
   *
   * It is what decides whether a run pays for a probe turn at all: a workflow
   * whose nodes never request a probed mode never waits on one. An empty list
   * means every mode this CLI claims, it has.
   */
  abstract readonly probedApprovalModes: readonly AgentApprovalMode[];

  /**
   * Translate the daemon's machine-capability bag into THIS CLI's installed
   * approval support.
   *
   * The bag is adapter-agnostic (`GET /v1/capabilities`), so every consumer can
   * hold one without knowing whose probe filled which field — and each adapter
   * reads only its own. Without this the translation lived in the consumers:
   * both of them imported claude's, and the gate in front of it was
   * `probedApprovalModes.includes(mode)` rather than "is this claude", so a
   * second CLI declaring any probed mode would have been judged against
   * CLAUDE's installed binary and silently degraded.
   *
   * A CLI with nothing to probe returns `{ supported: {} }` — absent, never
   * `false`, so a mode nobody asked about is still attempted and any genuine
   * rejection surfaces from the CLI itself.
   */
  abstract approvalSupportFrom(
    capabilities: InstalledCapabilities,
  ): InstalledApprovalSupport;

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
   */
  abstract resolveApprovalMode(
    requested: AgentApprovalMode,
    installed: InstalledApprovalSupport,
  ): ApprovalResolution;

  /**
   * Whether this CLI may hold the agent-call tools only after a machine-level
   * trust probe has PASSED, rather than on the strength of the endpoint grant
   * alone.
   *
   * True is the cautious answer: the run withholds the tools until a probe
   * verdict says otherwise, and the shut-out caller degrades visibly. False
   * means the endpoint is sufficient — the CLI accepts a per-turn server the
   * daemon hands it, with no persistent trust store in the way.
   */
  abstract readonly callToolsRequireTrustProbe: boolean;

  /**
   * Whether an MCP endpoint reaches this CLI ONLY through a config file in the
   * run's own cwd, merged before the spawn and restored after it.
   *
   * A CLI answering false takes the endpoint per turn (claude's
   * `--mcp-config`), which is both cheaper and safer — nothing outside the
   * turn ever sees the token. True obliges the caller to run the merge
   * lifecycle around the spawn.
   */
  abstract readonly mcpEndpointRequiresCwdConfig: boolean;

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
   * The reasoning-effort levels this CLI accepts for one turn, weakest first,
   * or `[]` when it has no such control at all.
   *
   * Synchronous because it is a documented constant on every adapter that has
   * one — nothing is asked of the binary. It must NOT be scraped from the
   * CLI's own help output: claude's `--help` under-reports its own vocabulary
   * (probe-verified — see `claude/claude-effort.ts`), so a scrape would
   * silently drop a level the CLI accepts.
   *
   * An adapter returning `[]` is the whole signal that the CLI has no effort
   * control: the consumer refuses an effort for it and the UI omits the
   * picker, without anything outside this layer knowing which CLI it is.
   */
  abstract listEfforts(): AgentEffort[];

  /**
   * The skills / slash commands this CLI can be invoked with in a folder, as
   * found on disk — each CLI keeps them under its own roots
   * (`.claude/skills`, `.claude/commands`, `.cursor/commands`), scanned in the
   * project folder and the user's home dir.
   *
   * Ordering is the adapter's: it returns them in the order the CLI would
   * resolve a collision, first occurrence winning. Never throws — one broken
   * file on disk must not fail the list.
   */
  abstract listSkills(input: AgentSkillsInput): Promise<AgentSkillEntry[]>;

  /**
   * The slash commands the CLI ITSELF reports it can run — its built-ins and
   * plugin commands, which exist nowhere on disk to be scanned.
   *
   * Only the binary knows this set, and only some CLIs will say: an adapter
   * whose CLI has no such report returns `[]`, and so does one that cannot be
   * asked right now. Never throws, and never hangs. The caller decides how
   * often to ask; this method always does the work when called.
   */
  abstract listReportedCommands(
    options?: AgentCommandOptions,
  ): Promise<string[]>;

  /**
   * Whether the INSTALLED binary can stream partial assistant text, so a turn
   * may be started with `streamPartials`.
   *
   * Asked rather than assumed because the answer is per-binary, not per-CLI: a
   * flag the current claude accepts is rejected on argv by an older one, which
   * would fail every turn instead of merely not streaming. A CLI with no such
   * mode answers false forever. Never throws; a CLI that cannot be asked
   * answers false, so the worst case is block streaming — exactly today's
   * behaviour.
   */
  abstract supportsLiveStream(options?: AgentCommandOptions): Promise<boolean>;

  /**
   * Run a short-lived utility command for THIS CLI and return its stdout, or
   * null if it failed, timed out, or the binary is missing.
   *
   * The single spawn path for everything that is not a turn — subclasses never
   * reach for `execFile` themselves, exactly as they never reach for
   * `runHeadlessCli`. It strips the daemon's `GENIRO_`-prefixed env like a
   * turn does, and hands the child to `onSpawn` so the caller can register it
   * for shutdown. Never rejects.
   */
  protected runCommand(
    args: string[],
    options: AgentCommandOptions = {},
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
            encoding: 'utf8',
            env: buildChildEnv(),
          },
          (err, stdout) => resolve(err ? null : String(stdout)),
        );
      } catch {
        // A missing binary throws synchronously on some platforms.
        resolve(null);
        return;
      }
      options.onSpawn?.(child);
    });
  }

  /** Map one parsed line of the CLI's stream-json output to normalized events. */
  protected abstract mapMessage(obj: unknown): AgentEvent[];

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
   * re-injects it here for its OWN child only (see `CursorAdapter`).
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
   * Report a diagnostic at the loudest level the configured sink offers.
   * Used for conditions that do not justify failing a turn but must not be
   * whispered either — an unverified CLI version, a dropped control subtype.
   */
  protected reportProblem(message: string): void {
    const logger = this.options.logger;
    if (logger?.error) {
      logger.error(message);
      return;
    }
    logger?.warn(message);
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
      handle = runHeadlessCli({
        command: this.command,
        args: this.buildArgs(input),
        cwd: input.cwd,
        env: this.buildEnv(input),
        stdinPayload: this.buildStdinPayload(input),
        keepStdinOpen: this.keepStdinOpen(input),
        buildApprovalResponse: (id, allow, updatedInput) =>
          this.buildApprovalResponse(id, allow, updatedInput),
        mapper: (obj) => this.mapMessage(obj),
        // The mappers are pure module-scope functions, so a control message
        // an adapter does not model comes back as data and is logged HERE —
        // the one caller of `mapMessage`, rather than once per consumer. It
        // is diagnostic, so it stops here and never reaches the turn.
        onEvent: (event) => {
          if (event.type === 'unhandled_control') {
            this.options.logger?.warn(
              `${this.kind}: unmodelled control_request subtype '${event.subtype}' — dropped`,
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
