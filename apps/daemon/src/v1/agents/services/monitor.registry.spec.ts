import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MonitorEvent, MonitorOwner } from '../chat.types';
import { MONITOR_RUN_MAX } from '../chat.types';
import {
  configureChildJournal,
  resetChildJournal,
} from '../utils/child-journal';
import { MonitorRegistry } from './monitor.registry';
import { ProcessRegistry } from './process-registry';

const owner: MonitorOwner = {
  runId: 'run-1',
  memberId: 'agent',
  caller: 'agent',
  conversationId: null,
  callId: null,
  target: 'chat',
};

const COUNT = 'for i in 1 2 3; do echo $i; sleep 0.3; done';
const FOREVER = 'while true; do sleep 1; done';

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupGone(pgid: number): Promise<boolean> {
  // Up to 4 s: a group that ignored SIGTERM is killed after a 2 s grace.
  for (let i = 0; i < 80; i += 1) {
    if (!groupAlive(pgid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function endOf(
  registry: MonitorRegistry,
): Promise<Extract<MonitorEvent, { type: 'end' }>> {
  return new Promise((resolve) => {
    const off = registry.subscribe((event) => {
      if (event.type === 'end') {
        off();
        resolve(event);
      }
    });
  });
}

describe('MonitorRegistry', () => {
  let dir: string;
  let processes: ProcessRegistry;
  let registry: MonitorRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-registry-'));
    processes = new ProcessRegistry();
    registry = new MonitorRegistry(processes);
  });

  afterEach(async () => {
    registry.stopRun(owner.runId, 'teardown');
    await registry.settled(owner.runId, 5000);
    resetChildJournal();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers 1, 2 and 3 in batches, then ends with exit code 0 and wakes', async () => {
    const events: MonitorEvent[] = [];
    registry.subscribe((event) => {
      events.push(event);
    });
    const ended = endOf(registry);
    expect(
      registry.start({
        owner,
        command: COUNT,
        description: 'count',
        timeoutMs: 10_000,
      }),
    ).toEqual({ status: 'started', id: 'm1', alsoRunning: [] });
    const end = await ended;

    expect(events[0]?.type).toBe('start');
    const delivered = events.flatMap((event) =>
      event.type === 'batch'
        ? event.batch.lines
        : event.type === 'end'
          ? (event.batch?.lines ?? [])
          : [],
    );
    expect(delivered).toEqual(['1', '2', '3']);
    expect(
      events.filter((event) => event.type === 'batch').length,
    ).toBeGreaterThan(1);
    expect(end.end).toEqual({ kind: 'exit', code: 0 });
    expect(end.wake).toBe(true);
    expect(registry.isRunning(owner.runId)).toBe(false);
  });

  it('files the shell under its own ProcessRegistry key, never the bare run id, and journals its group', async () => {
    const journal = configureChildJournal(join(dir, 'children.json'));
    registry.start({
      owner,
      command: FOREVER,
      description: 'loop',
      timeoutMs: 10_000,
    });
    const [listed] = registry.list(owner.runId);
    expect(processes.has(owner.runId)).toBe(false);
    expect(processes.has(`monitor:${owner.runId}:m1`)).toBe(true);
    expect(journal.live().map((child) => child.pid)).toContain(listed?.pid);
  });

  it(`refuses a monitor past ${MONITOR_RUN_MAX} in one run`, () => {
    for (let i = 0; i < MONITOR_RUN_MAX; i += 1) {
      expect(
        registry.start({
          owner,
          command: `${FOREVER} # ${i}`,
          description: `m${i}`,
          timeoutMs: 10_000,
        }).status,
      ).toBe('started');
    }
    expect(
      registry.start({
        owner,
        command: `${FOREVER} # one more`,
        description: 'one more',
        timeoutMs: 10_000,
      }),
    ).toEqual({
      status: 'refused',
      reason: expect.stringContaining(`already runs ${MONITOR_RUN_MAX}`),
    });
  });

  it('refuses a command the conversation already runs, naming the monitor that runs it', () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'first watch',
      timeoutMs: 10_000,
    });
    expect(
      registry.start({
        owner,
        command: FOREVER,
        description: 'second watch',
        timeoutMs: 10_000,
      }),
    ).toEqual({
      status: 'refused',
      reason: expect.stringContaining('monitor m1 (first watch) already runs'),
    });
    expect(registry.list(owner.runId).map(({ id }) => id)).toEqual(['m1']);
  });

  it('lets another conversation run the same command, and names only the caller’s own as also running', () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'mine',
      timeoutMs: 10_000,
    });
    expect(
      registry.start({
        owner: { ...owner, caller: 'other' },
        command: FOREVER,
        description: 'theirs',
        timeoutMs: 10_000,
      }),
    ).toEqual({ status: 'started', id: 'm2', alsoRunning: [] });
    expect(
      registry.start({
        owner,
        command: `${FOREVER} # newer`,
        description: 'newer',
        timeoutMs: 10_000,
      }),
    ).toEqual({
      status: 'started',
      id: 'm3',
      alsoRunning: [{ id: 'm1', description: 'mine' }],
    });
  });

  it('takes the same command again once the running one is being stopped, and no longer counts it as running', async () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'old',
      timeoutMs: 10_000,
    });
    expect(registry.stillRunning(owner.runId).map(({ id }) => id)).toEqual([
      'm1',
    ]);
    registry.stop(owner.runId, 'm1', 'agent');
    expect(registry.stillRunning(owner.runId)).toEqual([]);
    expect(registry.list(owner.runId).map(({ id }) => id)).toEqual(['m1']);
    expect(
      registry.start({
        owner,
        command: FOREVER,
        description: 'new',
        timeoutMs: 10_000,
      }),
    ).toEqual({ status: 'started', id: 'm2', alsoRunning: [] });
  });

  it('answers still running by conversation', () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'mine',
      timeoutMs: 10_000,
    });
    registry.start({
      owner: { ...owner, caller: 'other' },
      command: FOREVER,
      description: 'theirs',
      timeoutMs: 10_000,
    });
    expect(
      registry.stillRunning(owner.runId, owner.caller).map(({ id }) => id),
    ).toEqual(['m1']);
    expect(registry.stillRunning(owner.runId).map(({ id }) => id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('stops the whole group on a user stop, ending stopped and waking the agent', async () => {
    registry.start({
      owner,
      command: `sh -c '${FOREVER}' & ${FOREVER}`,
      description: 'loop',
      timeoutMs: 10_000,
    });
    const pgid = registry.list(owner.runId)[0]?.pid ?? 0;
    expect(groupAlive(pgid)).toBe(true);
    const ended = endOf(registry);
    expect(registry.stop(owner.runId, 'm1', 'user')).toEqual({
      status: 'stopped',
    });
    const end = await ended;
    expect(end.end).toEqual({ kind: 'stopped' });
    expect(end.wake).toBe(true);
    expect(await groupGone(pgid)).toBe(true);
    expect(registry.stop(owner.runId, 'm1', 'user')).toEqual({
      status: 'refused',
      reason: 'already ended: stopped',
    });
  });

  it("ends silently on the agent's own stop, and refuses another conversation's monitor", async () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'loop',
      timeoutMs: 10_000,
    });
    expect(registry.stop(owner.runId, 'm1', 'agent', 'someone-else')).toEqual({
      status: 'refused',
      reason: 'no running monitor m1 of yours',
    });
    const ended = endOf(registry);
    registry.stop(owner.runId, 'm1', 'agent', owner.caller);
    const end = await ended;
    expect(end.end).toEqual({ kind: 'stopped' });
    expect(end.wake).toBe(false);
  });

  it('ends timed out at its deadline', async () => {
    const ended = endOf(registry);
    registry.start({
      owner,
      command: FOREVER,
      description: 'loop',
      timeoutMs: 300,
    });
    const end = await ended;
    expect(end.end).toEqual({ kind: 'timeout' });
    expect(end.wake).toBe(true);
  });

  it('ends when its shell exits, ending what it backgrounded rather than waiting on the pipes it holds', async () => {
    const ended = endOf(registry);
    const startedAt = Date.now();
    registry.start({
      owner,
      command: 'sleep 30 & echo started',
      description: 'bg',
      timeoutMs: 60_000,
    });
    const pgid = registry.list(owner.runId)[0]?.pid ?? 0;
    const end = await ended;
    expect(end.end).toEqual({ kind: 'exit', code: 0 });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(await groupGone(pgid)).toBe(true);
  });

  it('kills a backgrounded child that ignores SIGTERM once the shell has exited', async () => {
    const ended = endOf(registry);
    registry.start({
      owner,
      command: `sh -c 'trap "" TERM; while true; do sleep 1; done' & echo started`,
      description: 'stubborn',
      timeoutMs: 60_000,
    });
    const pgid = registry.list(owner.runId)[0]?.pid ?? 0;
    await ended;
    expect(await groupGone(pgid)).toBe(true);
  });

  it('stops a flooding command as flooded and wakes the agent with what it gathered', async () => {
    const ended = endOf(registry);
    registry.start({
      owner,
      command: 'yes flood',
      description: 'noisy',
      timeoutMs: 60_000,
    });
    const end = await ended;
    expect(end.end).toEqual({ kind: 'flooded' });
    expect(end.wake).toBe(true);
    // What it printed before the stop goes out with its end.
    expect(end.batch?.lines[0]).toBe('flood');
    expect(end.stoppedBy).toBeNull();
  });

  it('never mints an id a previous launch already used in the run', () => {
    registry.noteUsedIds(owner.runId, ['m1', 'm4', 'notes']);
    expect(
      registry.start({
        owner,
        command: 'true',
        description: 'next',
        timeoutMs: 5000,
      }),
    ).toEqual({ status: 'started', id: 'm5', alsoRunning: [] });
  });

  it('refuses new monitors for a moment after the run is torn down', async () => {
    registry.start({
      owner,
      command: FOREVER,
      description: 'loop',
      timeoutMs: 10_000,
    });
    const ended = endOf(registry);
    registry.abortRun(owner.runId);
    expect((await ended).wake).toBe(false);
    expect(
      registry.start({
        owner,
        command: FOREVER,
        description: 'again',
        timeoutMs: 10_000,
      }),
    ).toMatchObject({ status: 'refused' });
    registry.allowRun(owner.runId);
    expect(
      registry.start({
        owner,
        command: FOREVER,
        description: 'again',
        timeoutMs: 10_000,
      }).status,
    ).toBe('started');
  });
});
