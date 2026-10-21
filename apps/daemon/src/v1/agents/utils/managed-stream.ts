import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';

import { awakeTimeout } from '../../../utils/sleep-watch';
import type { ProcessRegistry } from '../services/process-registry';
import { buildChildEnv } from './child-env';
import { childProcessHandle } from './child-handle';
import { trackDetachedChild } from './child-journal';
import {
  createGroupTerminator,
  GROUP_KILL_GRACE_MS,
  killProcessGroup,
} from './kill-tree';
import { isGroupAnchored } from './process-descendants';
import { type PlainProcess, scanPlainTable } from './run-process-scan';

/** The shell a streamed command line runs under. */
export const MANAGED_STREAM_SHELL = '/bin/sh';

/**
 * How long a shell that has exited may leave its pipes open — a descendant
 * that left the group holds them — before the stream settles on the exit.
 */
const EXIT_DRAIN_MS = 1000;

type StreamSpawnFn = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd?: string;
    stdio: ['ignore', 'pipe', 'pipe'];
    detached: true;
  },
) => ChildProcess;

export interface ManagedStreamOptions {
  /** The whole ProcessRegistry key — never a bare run id, which reads as a busy run. */
  registryKey: string;
  /** A shell command line, run as `/bin/sh -c <line>`. */
  commandLine: string;
  cwd?: string;
  /** Set after `buildChildEnv`'s strip — how the run tag reaches the child. */
  env?: Record<string, string>;
  timeoutMs: number;
  processes: ProcessRegistry;
  /** stdout and stderr, as they arrive, in arrival order. */
  onData: (chunk: string) => void;
  spawn?: StreamSpawnFn;
  /** The table the exit path reads the group's members from. */
  listProcesses?: () => Promise<PlainProcess[] | null>;
}

export interface ManagedStreamEnd {
  /** Null when the command was killed by a signal or never started. */
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Set when the shell could not be started at all. */
  spawnError?: string;
}

export interface ManagedStream {
  /** The shell's pid — its process group's id too. Null when it never started. */
  pid: number | null;
  /** End the whole group: SIGTERM, then SIGKILL after the grace period. */
  stop: () => void;
  ended: Promise<ManagedStreamEnd>;
}

/**
 * Run one long-lived command line and stream what it prints, under the same
 * rules as every other daemon child: its own detached process group recorded
 * in the child journal, registered with ProcessRegistry so shutdown reaches
 * it, `buildChildEnv`'s strip, and a deadline that ends the group.
 *
 * Deliberately a SHELL (`/bin/sh -c`), unlike `runManagedCommand`'s argv: the
 * line is an agent's own pipeline (`gh run watch … | grep --line-buffered …`),
 * shown to the user by the CLI's permission prompt before it runs. stdin is
 * closed; stdout and stderr are read together.
 *
 * The deadline is an `awakeTimeout`, so time the Mac spent asleep is not
 * counted against the command.
 *
 * The group is ended the moment the shell exits ({@link endGroupAfterExit}),
 * and only that path signals it afterwards: once the shell is gone its pid —
 * the group's id — can be reissued once the group empties, and a later stop
 * must never reach whoever holds it then.
 */
export function startManagedStream(
  options: ManagedStreamOptions,
): ManagedStream {
  const spawnFn = options.spawn ?? nodeSpawn;
  let settled = false;
  let exited = false;
  let timedOut = false;
  let resolveEnd: (end: ManagedStreamEnd) => void = () => undefined;
  const ended = new Promise<ManagedStreamEnd>((resolve) => {
    resolveEnd = resolve;
  });
  let child: ChildProcess;
  try {
    child = spawnFn(MANAGED_STREAM_SHELL, ['-c', options.commandLine], {
      env: buildChildEnv(options.env),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (err) {
    resolveEnd({
      code: null,
      signal: null,
      timedOut: false,
      spawnError: errorText(err),
    });
    return { pid: null, stop: () => undefined, ended };
  }
  // Ends the group while the shell runs; its SIGKILL never fires once the
  // shell has exited — the exit ends the group on its own terms below.
  const terminator = createGroupTerminator(child, {
    isGone: () => settled || exited,
  });
  const deadline = awakeTimeout(() => {
    timedOut = true;
    terminator.terminate();
  }, options.timeoutMs);
  let drain: NodeJS.Timeout | undefined;
  const settle = (end: Omit<ManagedStreamEnd, 'timedOut'>): void => {
    if (settled) {
      return;
    }
    settled = true;
    deadline.clear();
    clearTimeout(drain);
    terminator.disarm();
    resolveEnd({ ...end, timedOut });
  };
  trackDetachedChild(child, MANAGED_STREAM_SHELL);
  options.processes.register(
    options.registryKey,
    childProcessHandle(child, { processGroup: true }),
  );
  const forward = (chunk: string): void => {
    if (!settled) {
      options.onData(chunk);
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', forward);
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', forward);
  child.on('error', (err) => {
    if (!exited) {
      terminator.terminate();
    }
    settle({ code: null, signal: null, spawnError: errorText(err) });
  });
  child.on('exit', (code, signal) => {
    // The members still alive now pin the group's id, so ending it here is
    // safe; what it backgrounded does not outlive the command — TERM, then
    // KILL after the grace, as `runManagedCommand`'s `endGroupOnExit` does.
    exited = true;
    terminator.disarm();
    endGroupAfterExit(child.pid, options.listProcesses ?? scanPlainTable);
    drain = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ code, signal });
    }, EXIT_DRAIN_MS);
    drain.unref();
  });
  // `close` settles first in the common case: the last output is read before
  // the end is reported.
  child.on('close', (code, signal) => settle({ code, signal }));
  return {
    pid: child.pid ?? null,
    stop: () => {
      if (!settled && !exited) {
        terminator.terminate();
      }
    },
    ended,
  };
}

/**
 * End what a command left in its group once its shell has exited: SIGTERM at
 * once — a member still alive keeps the group's id from being reissued, and
 * an empty group takes no signal — then SIGKILL after the grace, only while a
 * member seen at the exit is still alive in the group with its start time
 * (`isGroupAnchored`, the reaper's rule for a group it recorded). A group the
 * SIGTERM emptied is never signalled again.
 */
function endGroupAfterExit(
  pgid: number | undefined,
  listProcesses: () => Promise<PlainProcess[] | null>,
): void {
  if (pgid === undefined || pgid <= 1) {
    return;
  }
  killProcessGroup(pgid, 'SIGTERM', () => undefined);
  void (async () => {
    const members = (await listProcesses())?.flatMap((row) =>
      row.pgid === pgid && row.startedAt !== null
        ? [{ pid: row.pid, startedAt: row.startedAt }]
        : [],
    );
    if (members === undefined || members.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, GROUP_KILL_GRACE_MS).unref();
    });
    const rows = await listProcesses();
    if (rows !== null && isGroupAnchored({ pgid, members }, rows)) {
      killProcessGroup(pgid, 'SIGKILL', () => undefined);
    }
  })().catch(() => undefined);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
