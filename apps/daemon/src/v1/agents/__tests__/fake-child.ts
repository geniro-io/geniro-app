import { EventEmitter } from 'node:events';

import type { SpawnedProcess, SpawnFn } from '../utils/spawn-cli';

/**
 * The synchronous child-process double every spec that drives `runHeadlessCli`
 * needs: no real I/O, no timers, no scheduling — an `emitData` call lands in the
 * code under test on the same tick.
 *
 * Shared rather than re-typed per spec. It was hand-rolled six times (the two
 * adapters, the base's mirror spec, and three `spawn-cli.*` specs) in six
 * subtly different shapes — one recorded `written`, another did not; one
 * captured the spawn `cwd`, another only `env`; only one recorded the kill
 * SIGNAL. Every one of those omissions is an assertion its spec could not make,
 * and a shared double is what stops the next spec inheriting a gap by copying
 * whichever neighbour it happened to open.
 *
 * It is deliberately the UNION of what those six needed: recording a field
 * nothing asserts on costs a spec nothing, while lacking one costs it a
 * rewrite. What it must NOT gain is behaviour — a double that decides things is
 * a second implementation of the thing under test. The one sanctioned
 * behavioural variant — a child that DIES when signalled — stays a subclass in
 * the single spec that needs it.
 *
 * Lives in `__tests__/` because it is test scaffolding with no production
 * caller: both of the daemon's build configs exclude that DIRECTORY, which is a
 * boundary the whole toolchain already understands (see
 * `.claude/rules/daemon-module-structure.md`). At `agents/` level rather than
 * deeper, because its specs span `adapters/` AND `utils/`.
 */
export class FakeReadable extends EventEmitter {
  setEncoding(): this {
    return this;
  }

  /** Deliver one chunk to whatever attached a `data` listener. */
  emitData(chunk: string): void {
    this.emit('data', chunk);
  }
}

/** The child's stdin, recording everything written to it. */
export class FakeWritable extends EventEmitter {
  written = '';
  ended = false;

  write(chunk: string): boolean {
    this.written += chunk;
    return true;
  }

  end(): this {
    this.ended = true;
    return this;
  }
}

export class FakeChild extends EventEmitter {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly stdin = new FakeWritable();
  /** The last signal `kill` was given, and how many times it was called. */
  killSignal: NodeJS.Signals | null = null;
  kills = 0;

  /**
   * `pid` doubles as the process-group id: `runHeadlessCli` spawns detached and
   * signals `-pid`, so a spec asserting the group reap needs a real number
   * here. Own-property (not a class field) because {@link SpawnedProcess}
   * declares `pid` readonly.
   */
  constructor(pid?: number) {
    super();
    if (pid !== undefined) {
      Object.defineProperty(this, 'pid', { value: pid, enumerable: true });
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killSignal = signal;
    this.kills += 1;
    return true;
  }
}

/** What the spawn seam was called with, for argv/cwd/env assertions. */
export interface CapturedSpawn {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * A {@link SpawnFn} seam answering with one child, and a record of the call.
 *
 * Pass your own child to use a subclass (or to hold a reference across two
 * spawns); omit it for a fresh {@link FakeChild}.
 */
export function fakeSpawn<C extends FakeChild = FakeChild>(
  child: C = new FakeChild() as C,
): { spawn: SpawnFn; child: C; captured: CapturedSpawn } {
  const captured: CapturedSpawn = {};
  const spawn: SpawnFn = (command, args, options) => {
    captured.command = command;
    captured.args = args;
    captured.cwd = options.cwd;
    captured.env = options.env;
    return child as unknown as SpawnedProcess;
  };
  return { spawn, child, captured };
}
