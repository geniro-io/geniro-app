import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeState } from '../../runs/entity/node-state.entity';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentEventBus } from './agent-events.bus';
import { CursorUsageService } from './cursor-usage.service';

const em = { fork: () => em } as unknown as EntityManager;

/**
 * The service with the MACHINE stood in for — the Keychain read and the CLI's
 * identity file, which are the only two things a poll needs from it. Everything
 * else (the fold, the write, the announce) is the real implementation.
 */
class TestCursorUsageService extends CursorUsageService {
  protected override async readIdentity(): Promise<{
    teamId: number;
    userId: number;
  } | null> {
    return { teamId: 1, userId: 2 };
  }

  protected override async readToken(): Promise<string | null> {
    return 'token';
  }
}

function cursorRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    agentKind: AgentKind.CursorAgent,
    cursorCostCents: null,
    cursorCostEvents: null,
    ...overrides,
  } as Run;
}

function deps(
  runs: Run[],
  sessionsByRun: Record<string, string[]>,
  /** Per-conversation watermark, keyed by session id. Absent = never priced. */
  watermarks: Record<string, number> = {},
): {
  service: CursorUsageService;
  writes: { id: string; data: Partial<Run> }[];
  marks: { runId: string; nodeId: string; throughMs: number }[];
  published: unknown[];
  onItem: (event: { runId: string }) => void;
  counts: { listed: number };
} {
  const writes: { id: string; data: Partial<Run> }[] = [];
  const marks: { runId: string; nodeId: string; throughMs: number }[] = [];
  const published: unknown[] = [];
  const counts = { listed: 0 };
  let onItem: (event: { runId: string }) => void = () => undefined;

  const runDao = {
    getAll: async () => {
      counts.listed += 1;
      return runs.filter((run) => run.agentKind === AgentKind.CursorAgent);
    },
    getById: async (id: string) => runs.find((run) => run.id === id) ?? null,
    updateById: async (id: string, data: Partial<Run>) => {
      writes.push({ id, data });
      return 1;
    },
  } as unknown as RunDao;

  const nodeStates = {
    listByRun: async (runId: string) =>
      (sessionsByRun[runId] ?? []).map(
        (agentSessionId, index) =>
          ({
            agentSessionId,
            nodeId: `node-${index}`,
            cursorSpendThroughMs: watermarks[agentSessionId] ?? null,
          }) as NodeState,
      ),
    rememberCursorSpendThrough: async (
      runId: string,
      nodeId: string,
      throughMs: number,
    ) => {
      marks.push({ runId, nodeId, throughMs });
    },
  } as unknown as NodeStateDao;

  const bus = {
    all: () => ({
      subscribe: (fn: (event: { runId: string }) => void) => {
        onItem = fn;
        return { unsubscribe: () => undefined };
      },
    }),
    allDeleted: () => ({
      subscribe: () => ({ unsubscribe: () => undefined }),
    }),
    publishRunStatus: (status: unknown) => published.push(status),
  } as unknown as AgentEventBus;

  const service = new TestCursorUsageService(runDao, nodeStates, em, bus);
  service.onModuleInit();
  return {
    service,
    writes,
    marks,
    published,
    onItem: (event) => onItem(event),
    counts,
  };
}

const EVENT_AT_MS = 1_788_358_173_608;

function event(
  conversationId: string,
  chargedCents: number,
  atMs: number = EVENT_AT_MS,
): unknown {
  return {
    conversationId,
    chargedCents,
    isChargeable: true,
    timestamp: String(atMs),
  };
}

/** One page of usage events, as Cursor's endpoint answers it. */
function answerWith(...events: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        usageEventsDisplay: events,
        totalUsageEventsCount: events.length,
      }),
    })),
  );
}

/** Let the bus subscriber's own async work settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Pin the clock, and return the way to move it.
 *
 * `Date.now` rather than fake timers: the floors are the whole subject here and
 * {@link flush} needs a real `setTimeout` to let the subscriber's promises land.
 */
function at(startMs: number): (nowMs: number) => void {
  const now = vi.spyOn(Date, 'now').mockReturnValue(startMs);
  return (nowMs) => now.mockReturnValue(nowMs);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CursorUsageService', () => {
  it('announces a run whose fetched spend changed', async () => {
    const run = cursorRun();
    const { service, writes, published } = deps([run], {
      'run-1': ['conv-1'],
    });
    answerWith(event('conv-1', 488.8));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { cursorCostCents: 488.8, cursorCostEvents: 1 } },
    ]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ runId: 'run-1', status: null });
    expect(
      (published[0] as { spendUpdatedAt: number }).spendUpdatedAt,
    ).toBeGreaterThan(0);
  });

  it('says nothing about a run whose figure has not moved', async () => {
    const run = cursorRun({ cursorCostCents: 488.8, cursorCostEvents: 1 });
    const { service, writes, published } = deps([run], {
      'run-1': ['conv-1'],
    });
    answerWith(event('conv-1', 488.8));

    await service.refresh(true);

    expect(writes).toEqual([]);
    expect(published).toEqual([]);
  });

  it('sums every conversation a run holds rather than keeping the last', async () => {
    const run = cursorRun();
    const { service, writes } = deps([run], {
      'run-1': ['conv-1', 'conv-2'],
    });
    answerWith(event('conv-1', 100), event('conv-2', 25));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { cursorCostCents: 125, cursorCostEvents: 2 } },
    ]);
  });

  it('polls a minute after a cursor item, well inside the ambient floor', async () => {
    const clock = at(1_000_000);
    const { service, counts, onItem } = deps([cursorRun()], {
      'run-1': ['conv-1'],
    });
    answerWith(event('conv-1', 10));
    await service.refresh(true);
    expect(counts.listed).toBe(1);

    // Half a minute on: too soon even for the live floor.
    clock(1_030_000);
    onItem({ runId: 'run-1' });
    await flush();
    expect(counts.listed).toBe(1);

    // Ninety seconds on: past the live floor, and nowhere near the ten-minute
    // one the ambient trigger waits for.
    clock(1_090_000);
    onItem({ runId: 'run-1' });
    await flush();
    expect(counts.listed).toBe(2);
  });

  it('ADDS what is new, so a thread billed for longer than the window never shrinks', async () => {
    // The window is ~61 minutes wide, so a conversation billed for longer than
    // that used to have its whole recorded total overwritten by the recent
    // slice — the displayed cost visibly ticking downward. Written as an add
    // over the watermark, the earlier spend survives.
    const run = cursorRun({ cursorCostCents: 500, cursorCostEvents: 5 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': EVENT_AT_MS - 1_000 },
    );
    answerWith(event('conv-1', 20));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { cursorCostCents: 520, cursorCostEvents: 6 } },
    ]);
  });

  it('counts an event the overlapping window re-reads exactly once', async () => {
    const run = cursorRun({ cursorCostCents: 500, cursorCostEvents: 5 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': EVENT_AT_MS },
    );
    answerWith(event('conv-1', 20));

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('re-baselines a run whose total predates the watermark, upward only', async () => {
    // Written by the replacing build, so it is one window's snapshot rather
    // than an accumulator — adding this window to it would count the overlap
    // twice. The LARGER of the two is taken instead: replacing outright would
    // shrink a long thread's recorded cost once on upgrade, which is the defect
    // the accumulator exists to fix.
    const run = cursorRun({ cursorCostCents: 999, cursorCostEvents: 9 });
    const { service, writes } = deps([run], { 'run-1': ['conv-1'] });
    answerWith(event('conv-1', 100));

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('re-baselines UP when this window knows more than the old snapshot', async () => {
    const run = cursorRun({ cursorCostCents: 10, cursorCostEvents: 1 });
    const { service, writes } = deps([run], { 'run-1': ['conv-1'] });
    answerWith(event('conv-1', 40), event('conv-1', 60, EVENT_AT_MS + 1_000));

    await service.refresh(true);

    expect(writes).toEqual([
      { id: 'run-1', data: { cursorCostCents: 100, cursorCostEvents: 2 } },
    ]);
  });

  it('advances the watermark to the newest event it counted', async () => {
    const { service, marks } = deps([cursorRun()], { 'run-1': ['conv-1'] });
    answerWith(
      event('conv-1', 10, EVENT_AT_MS),
      event('conv-1', 15, EVENT_AT_MS + 5_000),
    );

    await service.refresh(true);

    expect(marks).toEqual([
      { runId: 'run-1', nodeId: 'node-0', throughMs: EVENT_AT_MS + 5_000 },
    ]);
  });

  it('watermarks a conversation whose events carried NO readable timestamp', async () => {
    // Left unmarked, such a conversation is re-counted on every later poll —
    // the run's `priced` flag is set by any sibling that did mark — and the
    // total climbs without bound on a figure the user checks against their own
    // bill. Marked at the poll's own end, it is counted once.
    at(1_000_000);
    const { service, marks } = deps([cursorRun()], { 'run-1': ['conv-1'] });
    answerWith({
      conversationId: 'conv-1',
      chargedCents: 10,
      isChargeable: true,
      // no `timestamp` at all — the shape the fold cannot place
    });

    await service.refresh(true);

    expect(marks).toEqual([
      { runId: 'run-1', nodeId: 'node-0', throughMs: 1_000_000 },
    ]);
  });

  it('re-counts nothing on the poll after that watermark', async () => {
    at(2_000_000);
    const run = cursorRun({ cursorCostCents: 10, cursorCostEvents: 1 });
    const { service, writes } = deps(
      [run],
      { 'run-1': ['conv-1'] },
      { 'conv-1': 1_000_000 },
    );
    answerWith({
      conversationId: 'conv-1',
      chargedCents: 10,
      isChargeable: true,
    });

    await service.refresh(true);

    expect(writes).toEqual([]);
  });

  it('does not poll on an item from a run of another CLI', async () => {
    const clock = at(1_000_000);
    const { service, counts, onItem } = deps(
      [cursorRun(), cursorRun({ id: 'run-2', agentKind: AgentKind.Claude })],
      { 'run-1': ['conv-1'] },
    );
    answerWith(event('conv-1', 10));
    await service.refresh(true);
    expect(counts.listed).toBe(1);

    clock(1_090_000);
    onItem({ runId: 'run-2' });
    await flush();

    expect(counts.listed).toBe(1);
  });
});
