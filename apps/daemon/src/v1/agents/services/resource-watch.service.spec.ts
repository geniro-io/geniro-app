import { BadRequestException, NotFoundException } from '@packages/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RESOURCE_ALERT_CONFIG,
  type KeptProcessRoot,
  type ThreadResourceSample,
} from '../chat.types';
import type { StopCandidate } from '../utils/run-process-scan';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { MonitorRegistry } from './monitor.registry';
import { ResourceAlertEventBus } from './resource-alert-events.bus';
import {
  RESOURCE_WATCH_EVERY_MS,
  ResourceWatchService,
} from './resource-watch.service';
import type { RunProcessReaper } from './run-process-reaper.service';
import type { RunProcessesService } from './run-processes.service';

const GIB = 1024 ** 3;

function sample(
  rssBytes: number,
  overrides: Partial<ThreadResourceSample> = {},
): ThreadResourceSample {
  return {
    runId: 'run-1',
    title: 'CI-1033 — content visibility',
    agentKinds: ['claude'],
    rssBytes,
    heaviest: {
      pid: 4242,
      name: 'python3',
      label: 'python3 read_log.py api.log',
      rssBytes: rssBytes - GIB / 2,
      memberId: 'middle',
      agentKind: 'claude',
    },
    ...overrides,
  };
}

function candidate(pid: number, startedAt: number): StopCandidate {
  return {
    pid,
    ppid: 1,
    args: 'python3 read_log.py api.log',
    env: null,
    startedAt,
  } as unknown as StopCandidate;
}

function setup(
  options: {
    roots?: KeptProcessRoot[];
    samples?: (ThreadResourceSample[] | null)[];
    pressure?: number | null;
    freeDisk?: number | null;
    candidates?: StopCandidate[];
    monitors?: unknown[];
  } = {},
) {
  let now = 1_000_000;
  const roots = options.roots ?? [
    { key: 'run-1::node:middle', agent: 'claude', cwd: '/tmp', pid: 100 },
  ];
  const queue = [...(options.samples ?? [])];
  const sampleThreads = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next === undefined ? [] : next;
  });
  const readPressureLevel = vi.fn(async () => options.pressure ?? 1);
  const readFreeDiskBytes = vi.fn(async () =>
    options.freeDisk === undefined ? 200 * GIB : options.freeDisk,
  );
  const stopCandidates = vi.fn(
    async (): Promise<StopCandidate[]> => options.candidates ?? [],
  );
  const stopRecorded = vi.fn(
    async (): Promise<{ stopped: number[]; gone: number[] }> => ({
      stopped: [4242],
      gone: [],
    }),
  );
  const logger = { log: vi.fn(), warn: vi.fn() };
  const bus = new ResourceAlertEventBus();
  const published = vi.fn();
  bus.allChanges().subscribe(published);
  const sessions = { processRoots: vi.fn(() => roots) };
  const watch = new ResourceWatchService(
    { sampleThreads } as unknown as RunProcessesService,
    sessions as unknown as AgentSessionRegistry,
    { listAll: () => options.monitors ?? [] } as unknown as MonitorRegistry,
    { stopCandidates, stopRecorded } as unknown as RunProcessReaper,
    bus,
    {
      readPressureLevel,
      readFreeDiskBytes,
      now: () => now,
      logger,
    },
  );
  return {
    watch,
    sessions,
    sampleThreads,
    readPressureLevel,
    readFreeDiskBytes,
    stopCandidates,
    stopRecorded,
    published,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ResourceWatchService', () => {
  it('reads nothing while no thread has processes', async () => {
    const t = setup({ roots: [] });

    await t.watch.tick();

    expect(t.sampleThreads).not.toHaveBeenCalled();
    expect(t.readPressureLevel).not.toHaveBeenCalled();
    expect(t.readFreeDiskBytes).not.toHaveBeenCalled();
  });

  it('reads nothing while switched off, and drops the alerts it held', async () => {
    const t = setup({ samples: [[sample(9 * GIB)]] });
    await t.watch.tick();
    expect(t.watch.list().alerts).toHaveLength(1);
    t.published.mockClear();
    t.sampleThreads.mockClear();

    t.watch.setConfig({ ...DEFAULT_RESOURCE_ALERT_CONFIG, enabled: false });
    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([]);
    expect(t.published).toHaveBeenCalledTimes(1);
    expect(t.sampleThreads).not.toHaveBeenCalled();
  });

  it('raises a thread-memory alert naming the thread, member and command', async () => {
    const t = setup({
      samples: [[sample(9 * GIB)]],
      candidates: [candidate(4242, 5_000)],
    });

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({
        kind: 'thread-memory',
        runId: 'run-1',
        title: 'CI-1033 — content visibility',
        agentKind: 'claude',
        memberId: 'middle',
        command: {
          pid: 4242,
          name: 'python3',
          label: 'python3 read_log.py api.log',
          rssBytes: 9 * GIB - GIB / 2,
        },
        threadRssBytes: 9 * GIB,
        stoppable: true,
      }),
    ]);
    expect(t.published).toHaveBeenCalledTimes(1);
  });

  it('keeps one alert, unannounced, while the condition holds', async () => {
    const t = setup({ samples: [[sample(9 * GIB)], [sample(10 * GIB)]] });
    await t.watch.tick();
    const [first] = t.watch.list().alerts;

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({ id: first?.id, threadRssBytes: 10 * GIB }),
    ]);
    expect(t.published).toHaveBeenCalledTimes(1);
  });

  it('marks a command that is not a stop candidate unstoppable, and refuses to stop it', async () => {
    const t = setup({ samples: [[sample(9 * GIB)]], candidates: [] });
    await t.watch.tick();
    const [alert] = t.watch.list().alerts;
    expect(alert?.stoppable).toBe(false);

    await expect(t.watch.stop(alert?.id ?? '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(t.stopRecorded).not.toHaveBeenCalled();
  });

  it('stops exactly the recorded command through the reaper and drops the alert', async () => {
    const t = setup({
      samples: [[sample(9 * GIB)]],
      candidates: [candidate(4242, 5_000), candidate(4300, 6_000)],
    });
    await t.watch.tick();
    const [alert] = t.watch.list().alerts;
    t.published.mockClear();

    const result = await t.watch.stop(alert?.id ?? '');

    expect(t.stopRecorded).toHaveBeenCalledWith('run-1', [
      { pid: 4242, startedAt: 5_000 },
    ]);
    expect(result).toEqual({ stoppedPids: [4242] });
    expect(t.watch.list().alerts).toEqual([]);
    expect(t.published).toHaveBeenCalledTimes(1);
  });

  it('raises thread-growth once a minute of samples shows the rate', async () => {
    const t = setup({
      samples: [[sample(2.5 * GIB)], [sample(3 * GIB)], [sample(4 * GIB)]],
    });
    await t.watch.tick();
    t.advance(RESOURCE_WATCH_EVERY_MS);
    await t.watch.tick();
    expect(t.watch.list().alerts).toEqual([]);

    t.advance(RESOURCE_WATCH_EVERY_MS);
    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({
        kind: 'thread-growth',
        runId: 'run-1',
        growthBytesPerMinute: 1.5 * GIB,
      }),
    ]);
  });

  it('blames the heaviest thread for critical memory pressure', async () => {
    const t = setup({
      samples: [
        [
          sample(1 * GIB, { runId: 'light', title: 'Light' }),
          sample(5 * GIB, { runId: 'heavy', title: 'Heavy' }),
        ],
      ],
      pressure: 4,
    });

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({
        kind: 'memory-pressure',
        runId: 'heavy',
        title: 'Heavy',
      }),
    ]);
  });

  it('raises low disk with the free bytes and its line, blaming no thread', async () => {
    const t = setup({
      samples: [[sample(1 * GIB)]],
      freeDisk: 1.5 * GIB,
      candidates: [candidate(4242, 5_000)],
    });

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({
        kind: 'low-disk',
        freeDiskBytes: 1.5 * GIB,
        minFreeDiskBytes: DEFAULT_RESOURCE_ALERT_CONFIG.minFreeDiskBytes,
        runId: null,
        title: null,
        agentKind: null,
        memberId: null,
        command: null,
        threadRssBytes: null,
        growthBytesPerMinute: null,
        stoppable: false,
      }),
    ]);
    expect(t.stopCandidates).not.toHaveBeenCalled();
  });

  it('moves a held low-disk alert to the line now set, still blaming no thread', async () => {
    const t = setup({
      samples: [[sample(1 * GIB)], [sample(3 * GIB, { runId: 'run-2' })]],
      freeDisk: 1.5 * GIB,
    });
    await t.watch.tick();
    const raised = t.watch.list().alerts[0];
    t.watch.setConfig({
      ...DEFAULT_RESOURCE_ALERT_CONFIG,
      minFreeDiskBytes: 20 * GIB,
    });

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({
        id: raised?.id,
        kind: 'low-disk',
        minFreeDiskBytes: 20 * GIB,
        runId: null,
        command: null,
        threadRssBytes: null,
      }),
    ]);
  });

  it('carries no disk line on any other kind', async () => {
    const t = setup({ samples: [[sample(9 * GIB)]], pressure: 4 });

    await t.watch.tick();

    expect(
      t.watch.list().alerts.map((a) => [a.kind, a.minFreeDiskBytes]),
    ).toEqual([
      ['thread-memory', null],
      ['memory-pressure', null],
    ]);
  });

  it('keeps reading what agents left running, then stops once nothing is left', async () => {
    const t = setup({ samples: [[sample(9 * GIB)], []] });
    await t.watch.tick();
    t.sessions.processRoots.mockReturnValue([]);

    await t.watch.tick();
    expect(t.sampleThreads).toHaveBeenCalledTimes(2);
    expect(t.watch.list().alerts).toEqual([]);

    await t.watch.tick();
    expect(t.sampleThreads).toHaveBeenCalledTimes(2);
  });

  it('keeps a thread alert through an unreadable process table', async () => {
    const t = setup({ samples: [[sample(9 * GIB)], null] });
    await t.watch.tick();

    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({ kind: 'thread-memory' }),
    ]);
  });

  it('reads while only a monitor holds a thread', async () => {
    const t = setup({ roots: [], monitors: [{ id: 'm1' }] });

    await t.watch.tick();

    expect(t.sampleThreads).toHaveBeenCalledTimes(1);
  });

  it('refuses to stop an alert it does not hold', async () => {
    const t = setup();
    await expect(t.watch.stop('ra-nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('offers no Stop, and says why in the log, when the candidates could not be read', async () => {
    const t = setup({ samples: [[sample(9 * GIB)]] });
    t.stopCandidates.mockRejectedValueOnce(new Error('table changed'));

    await t.watch.tick();

    expect(t.watch.list().alerts[0]?.stoppable).toBe(false);
    expect(t.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('table changed'),
    );
  });

  it('keeps the last free-disk figure through an unreadable reading', async () => {
    let free: number | null = 1.5 * GIB;
    const t = setup({ samples: [[sample(1 * GIB)]] });
    t.readFreeDiskBytes.mockImplementation(async () => free);
    await t.watch.tick();

    free = null;
    await t.watch.tick();

    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({ kind: 'low-disk', freeDiskBytes: 1.5 * GIB }),
    ]);
  });

  it('keeps a system alert while no thread has processes, and drops the thread ones', async () => {
    const t = setup({ samples: [[sample(9 * GIB)], []], freeDisk: 1.5 * GIB });
    await t.watch.tick();
    const disk = t.watch.list().alerts.find((a) => a.kind === 'low-disk');
    t.sessions.processRoots.mockReturnValue([]);
    await t.watch.tick();
    t.sampleThreads.mockClear();

    await t.watch.tick();

    expect(t.sampleThreads).not.toHaveBeenCalled();
    expect(t.watch.list().alerts).toEqual([
      expect.objectContaining({ kind: 'low-disk', id: disk?.id }),
    ]);
  });

  it('follows the blamed command’s own memory while the alert holds', async () => {
    const t = setup({ samples: [[sample(9 * GIB)], [sample(11 * GIB)]] });
    await t.watch.tick();

    await t.watch.tick();

    expect(t.watch.list().alerts[0]?.command?.rssBytes).toBe(
      11 * GIB - GIB / 2,
    );
  });

  it('leaves an alert raised again while a stop was under way', async () => {
    const t = setup({
      samples: [[sample(9 * GIB)], [], [sample(9 * GIB)]],
      candidates: [candidate(4242, 5_000)],
    });
    await t.watch.tick();
    const [first] = t.watch.list().alerts;
    t.stopRecorded.mockImplementationOnce(async () => {
      await t.watch.tick();
      await t.watch.tick();
      return { stopped: [4242], gone: [] };
    });

    await t.watch.stop(first?.id ?? '');

    const [after] = t.watch.list().alerts;
    expect(after?.id).not.toBe(first?.id);
    expect(after?.kind).toBe('thread-memory');
  });

  it('names alerts apart from an earlier daemon’s', async () => {
    const a = setup({ samples: [[sample(9 * GIB)]] });
    const b = setup({ samples: [[sample(9 * GIB)]] });
    await a.watch.tick();
    await b.watch.tick();

    expect(a.watch.list().alerts[0]?.id).not.toBe(b.watch.list().alerts[0]?.id);
  });

  it('reads on its own every 30 s once the app has booted', async () => {
    vi.useFakeTimers();
    const t = setup({ samples: [[]] });
    t.watch.onApplicationBootstrap();

    await vi.advanceTimersByTimeAsync(RESOURCE_WATCH_EVERY_MS - 1);
    expect(t.sampleThreads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sampleThreads).toHaveBeenCalledTimes(1);

    t.watch.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(RESOURCE_WATCH_EVERY_MS);
    expect(t.sampleThreads).toHaveBeenCalledTimes(1);
  });
});
