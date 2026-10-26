import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeReadable } from '../__tests__/fake-child';
import { ProcessRegistry } from '../services/process-registry';
import { GROUP_KILL_GRACE_MS } from './kill-tree';
import { startManagedStream } from './managed-stream';
import type { PlainProcess } from './run-process-scan';

const PGID = 424_242;
const STARTED = Date.parse('Tue Oct 20 10:00:00 2026');

/** The shell, as `spawn` hands it back: it exits when the spec says so. */
class FakeShell extends EventEmitter {
  readonly pid = PGID;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  kill = vi.fn(() => true);
}

/** A process of the shell's group, as `ps` lists it. */
const member = (pid: number, startedAt: number): PlainProcess => ({
  pid,
  ppid: 1,
  pgid: PGID,
  uid: 501,
  tty: null,
  startedAt,
  args: 'sleep 900',
});

describe('startManagedStream — the group once the shell has exited', () => {
  let signals: [number, string | number | undefined][];

  beforeEach(() => {
    vi.useFakeTimers();
    signals = [];
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      signals.push([pid, signal]);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** Run a stream whose shell exits at once, the table reading as `tables` in turn. */
  async function exitWith(tables: (PlainProcess[] | null)[]): Promise<void> {
    const shell = new FakeShell();
    const listProcesses = vi.fn(async () => tables.shift() ?? null);
    startManagedStream({
      registryKey: 'monitor:run-1:m1',
      commandLine: 'sleep 900 &',
      timeoutMs: 60_000,
      processes: new ProcessRegistry(),
      onData: () => undefined,
      spawn: () => shell as unknown as ChildProcess,
      listProcesses,
    });
    shell.emit('exit', 0, null);
    shell.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS + 100);
  }

  it('asks the group to stop the moment the shell exits', async () => {
    await exitWith([[], []]);
    expect(signals).toContainEqual([-PGID, 'SIGTERM']);
  });

  it('force-kills what is still in the group after the grace', async () => {
    const stubborn = member(5001, STARTED);
    await exitWith([[stubborn], [stubborn]]);
    expect(signals).toEqual([
      [-PGID, 'SIGTERM'],
      [-PGID, 'SIGKILL'],
    ]);
  });

  it('never signals a group the SIGTERM emptied, even if its id is reissued meanwhile', async () => {
    const reissued = member(5002, STARTED + 60_000);
    await exitWith([[member(5001, STARTED)], [reissued]]);
    expect(signals).toEqual([[-PGID, 'SIGTERM']]);
  });

  it('never signals again when the group was already empty at the exit', async () => {
    await exitWith([[], [member(5002, STARTED)]]);
    expect(signals).toEqual([[-PGID, 'SIGTERM']]);
  });
});
