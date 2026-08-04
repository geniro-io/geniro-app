import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * A child-process double for the `processGroup: true` path of
 * `AgentAdapter.runCommand`, which spawns rather than execFiles.
 *
 * Shared by every spec that exercises a group-spawned utility command
 * (`mcp list` on both adapters, plus the base class's own reap tests) instead
 * of being re-typed per file — the reap contract is one behaviour, and three
 * hand-rolled doubles would drift the moment one of them grows a listener the
 * others lack.
 *
 * Lives in a `.spec-helper.ts` rather than a plain `.ts` because it is test
 * scaffolding: the daemon's build ignores that suffix exactly as it ignores
 * `.spec.ts`, so this never reaches `dist/`.
 */
export interface FakeGroupChild {
  /** The object `runCommand` receives — structurally a `ChildProcess`. */
  readonly child: ChildProcess;
  /** Push a stdout chunk the collector should accumulate. */
  writeStdout(chunk: string): void;
  /** End the child: emits `exit` then `close` with the given status. */
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Fail the spawn after the fact (ENOENT surfaced asynchronously). */
  fail(err?: Error): void;
  /** Direct-kill calls, so a spec can tell a group reap from a fallback. */
  readonly directKills: NodeJS.Signals[];
}

/** Build a fake group-spawned child. `pid` doubles as the process-group id. */
export function fakeGroupChild(pid = 4242): FakeGroupChild {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const directKills: NodeJS.Signals[] = [];

  const child = Object.assign(emitter, {
    pid,
    stdout,
    stderr,
    stdin: null,
    kill: (signal?: NodeJS.Signals): boolean => {
      directKills.push(signal ?? 'SIGTERM');
      return true;
    },
  }) as unknown as ChildProcess;

  return {
    child,
    directKills,
    writeStdout: (chunk) => stdout.emit('data', Buffer.from(chunk, 'utf8')),
    close: (code, signal = null) => {
      emitter.emit('exit', code, signal);
      emitter.emit('close', code, signal);
    },
    fail: (err = new Error('spawn ENOENT')) => emitter.emit('error', err),
  };
}

/**
 * A `groupSpawnFn` seam that answers with `stdout` and a clean exit.
 *
 * Emits ASYNCHRONOUSLY (a microtask), because node's own `spawn` does: a
 * double that fires its listeners before `runCommand` has attached them tests
 * a sequence production never runs, and would hide a listener registered too
 * late.
 */
export function spawnAnswering(
  stdout: string,
  pid = 4242,
  onSpawn?: (args: readonly string[], options: Record<string, unknown>) => void,
): typeof spawn {
  return ((
    _command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    const fake = fakeGroupChild(pid);
    onSpawn?.(args, options);
    queueMicrotask(() => {
      if (stdout) {
        fake.writeStdout(stdout);
      }
      fake.close(0);
    });
    return fake.child;
  }) as unknown as typeof spawn;
}
