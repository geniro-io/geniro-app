import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

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
 * `stdout` and `stderr` are REAL streams, not bare emitters. The collector
 * calls `setEncoding` on stdout and `resume` on stderr, and both of those are
 * behaviours worth exercising rather than stubbing: a `PassThrough` carries
 * node's own StringDecoder, so a spec that writes a split multi-byte sequence
 * is testing the decode this double claims to model.
 *
 * Lives in `__tests__/` rather than beside the code it doubles because it is
 * test scaffolding with no production caller: the daemon's build excludes that
 * DIRECTORY, so this never reaches `dist/`. A directory is the exclusion the
 * whole toolchain already understands — a bespoke filename suffix has to be
 * re-spelled in every build config that must skip it, and one config that
 * misses the spelling ships the helper silently.
 */
export interface FakeGroupChild {
  /** The object `runCommand` receives — structurally a `ChildProcess`. */
  readonly child: ChildProcess;
  /** Push one stdout chunk. A Buffer is delivered as raw bytes. */
  writeStdout(chunk: string | Buffer): void;
  /** Push one stderr chunk — nothing reads it unless the collector drains. */
  writeStderr(chunk: string | Buffer): void;
  /**
   * End the child: flushes stdout, then emits `exit` and `close`.
   *
   * The flush is why this is not two `emit` calls. A real child's `close`
   * arrives after its stdio has drained, and a double that fires it first
   * would let a correct collector lose the output it had already been handed.
   */
  close(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Fail the spawn after the fact (ENOENT surfaced asynchronously). */
  fail(err?: Error): void;
  /** Direct-kill calls, so a spec can tell a group reap from a fallback. */
  readonly directKills: NodeJS.Signals[];
}

/** Build a fake group-spawned child. `pid` doubles as the process-group id. */
export function fakeGroupChild(pid = 4242): FakeGroupChild {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
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
    writeStdout: (chunk) => void stdout.write(chunk),
    writeStderr: (chunk) => void stderr.write(chunk),
    close: (code, signal = null) => {
      const settle = (): void => {
        emitter.emit('exit', code, signal);
        emitter.emit('close', code, signal);
      };
      // `end` flushes what is buffered; `finish` fires once it has. An
      // unconsumed stream still finishes, so this cannot wedge a spec that
      // never reads stdout.
      stdout.once('finish', settle);
      stdout.end();
      stderr.end();
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
