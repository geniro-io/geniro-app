import type { AgentKind } from '../../runs/runs.types';
import { runHeadlessCli, type SpawnFn } from '../utils/spawn-cli';
import type {
  AgentEvent,
  AgentTurnHandle,
  AgentTurnInput,
} from './adapter.types';

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

  constructor(protected readonly options: AgentAdapterOptions = {}) {}

  /** Build the argv for one turn (model/resume flags, prompt when positional). */
  protected abstract buildArgs(input: AgentTurnInput): string[];

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
