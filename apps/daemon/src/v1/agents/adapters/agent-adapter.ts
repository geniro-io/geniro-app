import { type ChildProcess, execFile } from 'node:child_process';

import type { AgentKind } from '../../runs/runs.types';
import { buildChildEnv } from '../utils/child-env';
import { runHeadlessCli, type SpawnFn } from '../utils/spawn-cli';
import type {
  AgentCommandOptions,
  AgentEvent,
  AgentModel,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentTurnHandle,
  AgentTurnInput,
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
  /** Sink for skipped-unparseable-line warnings; defaults to silent. */
  logger?: { warn(message: string): void };
  /** Replacement execFile for the utility commands in tests; defaults to node's. */
  execFileFn?: typeof execFile;
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
        onEvent,
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
