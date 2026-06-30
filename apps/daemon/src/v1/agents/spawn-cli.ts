import { spawn as nodeSpawn } from 'node:child_process';

import type { AgentEvent, ExecutorHandle } from './executor.types';
import { NdjsonBuffer } from './ndjson-buffer';

/**
 * The slice of a child process this module depends on. Narrower than node's
 * `ChildProcess` so a test can supply a fake without reconstructing the whole
 * interface — the real `spawn` result satisfies it structurally.
 */
export interface SpawnedProcess {
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

/** Default: node's `spawn` with all three stdio streams piped. */
export const defaultSpawn: SpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });

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
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
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

/**
 * Build the spawned agent's environment from the daemon's, stripping every
 * `GENIRO_`-prefixed key. Those carry the daemon's own config and secrets — most
 * importantly the Cursor key, which the daemon receives as `GENIRO_CURSOR_API_KEY`
 * and the Cursor adapter re-injects as `CURSOR_API_KEY` via `extra` for its child
 * ONLY. Stripping them means the claude child (and any tool it spawns) never
 * inherits another agent's credential or the daemon's internal env.
 */
function buildChildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GENIRO_')) {
      env[key] = value;
    }
  }
  return { ...env, ...extra };
}

/**
 * Spawn a headless CLI agent, reassemble its stdout NDJSON, map each object to
 * normalized {@link AgentEvent}s, and surface a single settle point. Terminal
 * conditions are normalized: a signal-kill (cancel/shutdown) yields a
 * `turn_cancelled`, a non-zero exit yields an `error` (with the stderr tail),
 * and a clean exit relies on the `result` line the mapper already turned into
 * `turn_complete`. `done` never rejects — every outcome is an event first.
 */
export function runHeadlessCli(opts: RunCliOptions): ExecutorHandle {
  const spawnFn = opts.spawn ?? defaultSpawn;

  let settled = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const settle = (): void => {
    if (!settled) {
      settled = true;
      resolveDone();
    }
  };

  // Emit at most ONE terminal event per turn, whichever arrives first: a
  // `result`-line `turn_complete` from the mapper, a signal-kill
  // `turn_cancelled`, or an `error`. Without this gate a child that prints a
  // success `result` AND then exits non-zero (or fires `error` then `close`)
  // would emit two contradictory terminal items for one turn.
  let terminalEmitted = false;
  const emit = (event: AgentEvent): void => {
    if (
      event.type === 'turn_complete' ||
      event.type === 'turn_cancelled' ||
      event.type === 'error'
    ) {
      if (terminalEmitted) {
        return;
      }
      terminalEmitted = true;
    }
    opts.onEvent(event);
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
    return { done, cancel: () => {} };
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
  child.stdout?.on('data', (chunk: string | Buffer) =>
    buffer.push(toUtf8(chunk)),
  );

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderrTail = (stderrTail + toUtf8(chunk)).slice(-2000);
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

  const stdin = child.stdin;
  if (stdin) {
    // A stdin that errors asynchronously (EPIPE — the CLI exited before we
    // finished writing) would otherwise throw an unhandled stream error and
    // crash the daemon; surface it as a normal terminal error instead.
    stdin.on('error', (err: Error) => {
      if (settled) {
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
      stdin.end();
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

  return {
    done,
    cancel: () => {
      if (!settled) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* process already gone — nothing to kill */
        }
      }
    },
  };
}
