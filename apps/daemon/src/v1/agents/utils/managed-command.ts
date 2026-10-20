import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ProcessRegistry } from '../services/process-registry';
import { buildChildEnv } from './child-env';
import { childProcessHandle } from './child-handle';
import { trackDetachedChild } from './child-journal';
import { createGroupTerminator } from './kill-tree';

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * With `endGroupOnExit`: how long a child that has exited may keep its pipes
 * open — a descendant that left its group holds them, and `close` waits for
 * every holder — before the run is settled on the exit alone.
 */
const EXIT_DRAIN_MS = 1000;

type ManagedSpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdio: ['pipe', 'pipe', 'pipe'];
    detached: true;
  },
) => ChildProcess;

export interface ManagedCommandOptions {
  /** Prefix of the ProcessRegistry key, e.g. `share:upload`. */
  label: string;
  command: string;
  args: string[];
  /** Written to stdin, which is then closed — the only way a secret reaches the child. */
  stdin?: string;
  timeoutMs: number;
  processes: ProcessRegistry;
  env?: Record<string, string>;
  /** Absent: the daemon's own working directory. */
  cwd?: string;
  maxOutputChars?: number;
  /**
   * Which end of a long output survives the cap: the `head` (default) for a
   * CLI whose answer comes first, the `tail` where the end says how it went —
   * which also fills `output`, both streams in the order they arrived.
   */
  keepOutput?: 'head' | 'tail';
  /**
   * End the child's process group as soon as the child exits — what it
   * backgrounded does not outlive it, whatever its output went to — and
   * settle on that exit even if a descendant that left the group still holds
   * the pipes. Without it the run lasts until every pipe holder is gone.
   */
  endGroupOnExit?: boolean;
  /** Aborting kills the group as the deadline does; `timedOut` stays false. */
  signal?: AbortSignal;
  spawn?: ManagedSpawnFn;
}

export interface ManagedCommandResult {
  /** Null when the child was killed or never started. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the binary could not be started at all (ENOENT, EACCES). */
  spawnError?: string;
  /** `keepOutput: 'tail'` only: the end of stdout and stderr as interleaved. */
  output?: string;
}

/**
 * Run one non-agent CLI command (an upload, a Keychain write) under the same
 * rules as an agent's utility command: a detached process group recorded in
 * the child journal, registered with ProcessRegistry so cancel and shutdown
 * reach it, killed as a group at the deadline, with `buildChildEnv`'s strip.
 *
 * argv only — never a shell — so no token of `args` is ever reinterpreted.
 */
export function runManagedCommand(
  options: ManagedCommandOptions,
): Promise<ManagedCommandResult> {
  const spawnFn = options.spawn ?? nodeSpawn;
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    let drain: NodeJS.Timeout | undefined;
    let settled = false;
    let child: ChildProcess;
    const settle = (
      result: Pick<ManagedCommandResult, 'code' | 'spawnError'>,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        ...result,
        stdout,
        stderr,
        timedOut,
        ...(options.keepOutput === 'tail' ? { output } : {}),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      createGroupTerminator(child, { isGone: () => settled }).terminate();
    }, options.timeoutMs);
    timer.unref?.();
    const abort = (): void => {
      createGroupTerminator(child, { isGone: () => settled }).terminate();
    };
    if (options.signal?.aborted) {
      settle({ code: null, spawnError: 'aborted before it started' });
      return;
    }
    try {
      child = spawnFn(options.command, options.args, {
        env: buildChildEnv(options.env),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      settle({ code: null, spawnError: errorText(err) });
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    trackDetachedChild(child, options.command);
    options.processes.register(
      `${options.label}:${randomUUID()}`,
      childProcessHandle(child, { processGroup: true }),
    );
    const append =
      options.keepOutput === 'tail'
        ? (current: string, chunk: string): string =>
            (current + chunk).slice(-maxChars)
        : (current: string, chunk: string): string =>
            current.length >= maxChars
              ? current
              : (current + chunk).slice(0, maxChars);
    child.stdout?.setEncoding('utf8');
    const tail = options.keepOutput === 'tail';
    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
      if (tail) {
        output = append(output, chunk);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
      if (tail) {
        output = append(output, chunk);
      }
    });
    child.on('error', (err) => {
      createGroupTerminator(child, { isGone: () => settled }).terminate();
      settle({ code: null, spawnError: errorText(err) });
    });
    child.on('close', (code) => settle({ code }));
    if (options.endGroupOnExit) {
      child.on('exit', (code) => {
        createGroupTerminator(child).terminate();
        drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          settle({ code });
        }, EXIT_DRAIN_MS);
        drain.unref?.();
      });
    }
    // A child that exits before reading stdin raises EPIPE here; `close`
    // still reports how it ended.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
