import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { ProcessRegistry } from '../services/process-registry';
import { buildChildEnv } from './child-env';
import { childProcessHandle } from './child-handle';
import { trackDetachedChild } from './child-journal';
import { createGroupTerminator } from './kill-tree';

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

type ManagedSpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
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
  maxOutputChars?: number;
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
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    const settle = (
      result: Omit<ManagedCommandResult, 'stdout' | 'stderr' | 'timedOut'>,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      createGroupTerminator(child, { isGone: () => settled }).terminate();
    }, options.timeoutMs);
    timer.unref?.();
    try {
      child = spawnFn(options.command, options.args, {
        env: buildChildEnv(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (err) {
      settle({ code: null, spawnError: errorText(err) });
      return;
    }
    trackDetachedChild(child, options.command);
    options.processes.register(
      `${options.label}:${randomUUID()}`,
      childProcessHandle(child, { processGroup: true }),
    );
    const append = (current: string, chunk: string): string =>
      current.length >= maxChars
        ? current
        : (current + chunk).slice(0, maxChars);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (err) => {
      createGroupTerminator(child, { isGone: () => settled }).terminate();
      settle({ code: null, spawnError: errorText(err) });
    });
    child.on('close', (code) => settle({ code }));
    // A child that exits before reading stdin raises EPIPE here; `close`
    // still reports how it ended.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.stdin ?? '');
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
