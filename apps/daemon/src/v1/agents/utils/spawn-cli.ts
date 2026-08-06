import { spawn as nodeSpawn } from 'node:child_process';

import type {
  AgentEvent,
  AgentTurnHandle,
  FollowUpMessage,
  TurnIo,
} from '../adapters/adapter.types';
import { buildChildEnv } from './child-env';
import { trackDetachedChild } from './child-journal';
import { killProcessGroup } from './kill-tree';
import { NdjsonBuffer } from './ndjson-buffer';

/**
 * The slice of a child process this module depends on. Narrower than node's
 * `ChildProcess` so a test can supply a fake without reconstructing the whole
 * interface — the real `spawn` result satisfies it structurally.
 */
export interface SpawnedProcess {
  /** Child PID. Doubles as the process-group id when spawned `detached`. */
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * Default: node's `spawn` with all three stdio streams piped, and `detached` so
 * the child becomes its own process-group leader. That lets {@link runHeadlessCli}
 * signal the WHOLE group on cancel/shutdown (`process.kill(-pid, …)`) and reap the
 * tool/MCP grandchildren a coding agent forks — a single-PID kill would orphan them.
 *
 * `detached` is also what makes the group survive the daemon's own death, so the
 * spawn is journaled here — in the same expression that creates it, before any
 * caller can see the child. The next boot reaps whatever the journal still
 * holds; see `child-journal.ts`.
 */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  trackDetachedChild(child, command);
  return child;
};

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin before stdin is closed. When undefined, stdin
   * is closed immediately with no payload (so a CLI that reads its prompt from
   * args never blocks waiting on stdin).
   */
  stdinPayload?: string;
  /**
   * Keep stdin open after the payload so the turn can carry a mid-turn
   * dialogue (the approval control protocol). Stdin is closed as soon as a
   * terminal event is emitted, letting the CLI exit; without that close a
   * stream-json CLI waits on stdin forever.
   */
  keepStdinOpen?: boolean;
  /**
   * Encode one approval verdict as the stdin line the CLI expects (the
   * adapter owns the wire format). Undefined = this CLI has no approval
   * protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?: (
    id: string,
    allow: boolean,
    updatedInput?: unknown,
  ) => string | undefined;
  /**
   * Encode a user message sent while THIS turn is still running, as the stdin
   * line the CLI expects. Undefined = this CLI cannot be told anything more
   * once its prompt is in, and `sendUserMessage` is a no-op.
   */
  buildFollowUpPayload?: (message: FollowUpMessage) => string | undefined;
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
  /**
   * Called once the child's stdin is wired and the one-shot payload (if any)
   * has been written — before the handle is returned, so a client-initiated
   * protocol can send its opening message ahead of any stdout. The writer
   * returns false once the turn has settled. Requires `keepStdinOpen` for any
   * protocol that writes more than once.
   */
  onStdinReady?: (io: TurnIo) => void;
  onEvent: (event: AgentEvent) => void;
  spawn?: SpawnFn;
  logger?: { warn(message: string): void };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toUtf8(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

/** Bytes of a child's stderr retained for the failure message on a non-zero exit. */
const STDERR_TAIL_BYTES = 2000;

/** Grace after a SIGTERM cancel before the process group is force-killed (SIGKILL). */
const SIGKILL_GRACE_MS = 2000;

/**
 * Signal the child's entire process group so the tool/MCP grandchildren a coding
 * agent forks die with it. The child is spawned `detached` (a group leader), so
 * its PID doubles as the group id and `process.kill(-pid, …)` reaches every
 * descendant. Falls back to a direct `child.kill` when the PID is unavailable
 * (e.g. a test fake) or the group is already gone — never throws.
 */
function killProcessTree(child: SpawnedProcess, signal: NodeJS.Signals): void {
  killProcessGroup(child.pid, signal, () => child.kill(signal));
}

/**
 * Spawn a headless CLI agent, reassemble its stdout NDJSON, map each object to
 * normalized {@link AgentEvent}s, and surface a single settle point. Terminal
 * conditions are normalized: a signal-kill (cancel/shutdown) yields a
 * `turn_cancelled`, a non-zero exit yields an `error` (with the stderr tail),
 * and a clean exit relies on the `result` line the mapper already turned into
 * `turn_complete`. `done` never rejects — every outcome is an event first.
 */
export function runHeadlessCli(opts: RunCliOptions): AgentTurnHandle {
  const spawnFn = opts.spawn ?? defaultSpawn;

  let settled = false;
  let resolveDone!: () => void;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settle = (): void => {
    if (!settled) {
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      resolveDone();
    }
  };

  // Emit at most ONE terminal event per turn, whichever arrives first: a
  // `result`-line `turn_complete` from the mapper, a signal-kill
  // `turn_cancelled`, or an `error`. Without this gate a child that prints a
  // success `result` AND then exits non-zero (or fires `error` then `close`)
  // would emit two contradictory terminal items for one turn.
  let terminalEmitted = false;
  // A cancel() was requested: the CLI usually reacts to the SIGTERM by
  // printing an is_error result line (or exiting non-zero) BEFORE the
  // signal-kill reaches `close`, and that error would win the one-terminal
  // race — recording a fake failure for a deliberate stop. So after a cancel
  // an `error` terminal is normalized to `turn_cancelled`; a genuine
  // `turn_complete` that raced the kill still wins (the turn really finished).
  let cancelRequested = false;
  // Assigned once the child's stdin is wired; a kept-open stdin is closed on
  // the terminal event so the stream-json CLI stops waiting and exits.
  let endStdin: (() => void) | null = null;
  const emit = (event: AgentEvent): void => {
    const normalized: AgentEvent =
      cancelRequested && event.type === 'error'
        ? { type: 'turn_cancelled' }
        : event;
    if (
      normalized.type === 'turn_complete' ||
      normalized.type === 'turn_cancelled' ||
      normalized.type === 'error'
    ) {
      if (terminalEmitted) {
        return;
      }
      terminalEmitted = true;
      endStdin?.();
    }
    opts.onEvent(normalized);
  };

  let child: SpawnedProcess;
  try {
    child = spawnFn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.env),
    });
  } catch (err) {
    emit({
      type: 'error',
      message: `failed to spawn ${opts.command}: ${errorMessage(err)}`,
    });
    settle();
    return {
      done,
      cancel: () => {},
      respondApproval: () => false,
      sendUserMessage: () => false,
    };
  }

  const buffer = new NdjsonBuffer({
    onObject: (obj) => {
      for (const event of opts.mapper(obj)) {
        emit(event);
      }
    },
    onParseError: (line) =>
      opts.logger?.warn(
        `${opts.command}: skipped unparseable stream line: ${line.slice(0, 200)}`,
      ),
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    const text = toUtf8(chunk);
    buffer.push(text);
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    const text = toUtf8(chunk);
    stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
  });

  child.on('error', (err: Error) => {
    if (settled) {
      return;
    }
    emit({
      type: 'error',
      message: `${opts.command} process error: ${err.message}`,
    });
    settle();
  });

  // `close` fires after stdio is fully drained AND the process has exited, so
  // every stdout line is parsed before the terminal event — `exit` can race the
  // last chunk. Guard on `settled`: a child can surface a process-level `error`
  // and THEN fire `close` with a non-zero code; without this guard both handlers
  // emit a terminal event and the transcript records two contradictory ones.
  child.on('close', (code, signal) => {
    if (settled) {
      return;
    }
    buffer.flush();
    if (signal) {
      emit({ type: 'turn_cancelled' });
    } else if (code !== null && code !== 0) {
      const detail = stderrTail.trim();
      emit({
        type: 'error',
        message: `${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
      });
    }
    settle();
  });

  // The one write path to the child's stdin, shared by the approval verdict
  // round-trip and by a client-initiated protocol driver. Re-reads `child.stdin`
  // per call so a stream torn down mid-turn is caught here rather than by a
  // stale reference, and never throws — a closed pipe is a dropped write, and
  // the child's own `close` handler owns the terminal event.
  const writeStdin = (payload: string): boolean => {
    if (settled || terminalEmitted) {
      return false;
    }
    const stream = child.stdin;
    if (!stream) {
      return false;
    }
    try {
      stream.write(payload);
      return true;
    } catch {
      return false;
    }
  };

  const stdin = child.stdin;
  if (stdin) {
    // A stdin that errors asynchronously (EPIPE — the CLI exited before we
    // finished writing) would otherwise throw an unhandled stream error and
    // crash the daemon; surface it as a normal terminal error instead.
    stdin.on('error', (err: Error) => {
      if (settled) {
        return;
      }
      // After the terminal event the turn is already decided — a late EPIPE
      // (e.g. closing a kept-open stdin as the child exits) must not settle
      // early, or `close` would skip the final buffer flush and `done` would
      // resolve before stdout drains.
      if (terminalEmitted) {
        return;
      }
      emit({
        type: 'error',
        message: `${opts.command} stdin error: ${err.message}`,
      });
      settle();
    });
    // The write/end can also throw synchronously (stdin already destroyed).
    // Keep it inside the settle contract: surface an error event and settle
    // rather than letting the throw unwind before the handle is returned.
    try {
      if (opts.stdinPayload !== undefined) {
        stdin.write(opts.stdinPayload);
      }
      if (opts.keepStdinOpen) {
        endStdin = () => {
          endStdin = null;
          try {
            stdin.end();
          } catch {
            // Already closed with the child's exit — nothing to end.
          }
        };
      } else {
        stdin.end();
      }
    } catch (err) {
      if (!settled) {
        emit({
          type: 'error',
          message: `failed to write ${opts.command} stdin: ${errorMessage(err)}`,
        });
        settle();
      }
    }
  }

  // After the payload, before any stdout is parsed: a protocol whose FIRST
  // message comes from the client (ACP's `initialize`) opens here. Runs inside
  // the same synchronous window as the spawn, so the opening message is queued
  // on stdin before the child can answer it.
  opts.onStdinReady?.({ write: writeStdin, emit });

  return {
    done,
    respondApproval: (id, allow, updatedInput) => {
      if (settled || terminalEmitted) {
        return false;
      }
      const line = opts.buildApprovalResponse?.(id, allow, updatedInput);
      if (line === undefined) {
        return false;
      }
      return writeStdin(line);
    },
    sendUserMessage: (message) => {
      // Guarded like the verdict above, and for the same reason: a write that
      // lands after the turn settled would be reported as delivered while the
      // agent never sees it, and the caller would drop it from its queue.
      if (settled || terminalEmitted) {
        return false;
      }
      const line = opts.buildFollowUpPayload?.(message);
      if (line === undefined) {
        return false;
      }
      return writeStdin(line);
    },
    cancel: () => {
      if (settled) {
        return;
      }
      cancelRequested = true;
      // Kill the whole process group — the CLI plus any tool/MCP grandchildren —
      // not just the direct child a single-PID SIGTERM would reach. Escalate to
      // SIGKILL if the group is still alive after the grace window.
      killProcessTree(child, 'SIGTERM');
      if (!killTimer) {
        killTimer = setTimeout(() => {
          killTimer = null;
          if (!settled) {
            killProcessTree(child, 'SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
        killTimer.unref?.();
      }
    },
  };
}
