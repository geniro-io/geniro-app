import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AgentKind } from '../../runs/runs.types';
import type { UsageEventDao } from '../../stats/dao/usage-event.dao';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonSpendService } from './lesson-spend.service';

const NOW = new Date(2026, 10, 15, 14, 0, 0);
const TODAY = new Date(2026, 10, 15, 9, 0, 0);
const EARLIER_THIS_MONTH = new Date(2026, 10, 3, 9, 0, 0);

interface Row {
  runId: string;
  purpose: 'lessons' | 'lessons_check';
  costUsd: number | null;
  occurredAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    runId: 'r1',
    purpose: 'lessons',
    costUsd: 0.1,
    occurredAt: TODAY,
    ...overrides,
  };
}

type FakeFailure = {
  class: 'rate_limited' | 'auth_expired' | 'crashed';
  resetsAt: string | null;
};

function fakeAdapter(
  recognise: (message: string) => FakeFailure | null,
): AgentAdapter & { failureFrom: ReturnType<typeof vi.fn> } {
  return {
    failureFrom: vi.fn(
      (message: string): FakeFailure =>
        recognise(message) ?? { class: 'crashed', resetsAt: null },
    ),
  } as unknown as AgentAdapter & { failureFrom: ReturnType<typeof vi.fn> };
}

const claudeLike = fakeAdapter((message) =>
  message.includes('weekly limit')
    ? { class: 'rate_limited', resetsAt: '4pm' }
    : message.includes('Failed to authenticate')
      ? { class: 'auth_expired', resetsAt: null }
      : null,
);

function build(
  options: {
    usage?: Row[];
    ended?: { runId: string }[];
    failed?: {
      id: string;
      runId: string;
      failReason: string | null;
      reflectionRunId?: string | null;
    }[];
    reflectionKinds?: Record<string, AgentKind | null>;
    adapters?: Partial<Record<AgentKind, AgentAdapter>>;
    saved?: number;
    titles?: Record<string, string>;
    finished?: {
      id: string;
      reflectionRunId: string | null;
      checkRunId: string | null;
    }[];
    ledger?: {
      runId: string;
      model: string | null;
      costUsd: number | null;
      durationMs: number | null;
    }[];
  } = {},
) {
  const em = { fork: () => em } as unknown as EntityManager;
  const usage = {
    ofPurposesSince: vi.fn(() => Promise.resolve(options.usage ?? [])),
    rowsByRuns: vi.fn((runIds: string[]) =>
      Promise.resolve(
        (options.ledger ?? []).filter((entry) => runIds.includes(entry.runId)),
      ),
    ),
  };
  const segments = {
    listChangedSince: vi.fn(() => Promise.resolve(options.ended ?? [])),
    listByStatus: vi.fn(() => Promise.resolve(options.failed ?? [])),
    listFinished: vi.fn(() => Promise.resolve(options.finished ?? [])),
  };
  const proposals = {
    savedSince: vi.fn(() => Promise.resolve(options.saved ?? 0)),
  };
  const runDao = {
    getById: vi.fn((id: string) =>
      Promise.resolve(
        options.reflectionKinds?.[id] !== undefined
          ? { id, title: null, agentKind: options.reflectionKinds[id] }
          : options.titles?.[id] === undefined
            ? null
            : { id, title: options.titles[id], agentKind: null },
      ),
    ),
  };
  const adapterMap = options.adapters ?? { claude: claudeLike };
  const registry = {
    for: vi.fn((kind: AgentKind) => adapterMap[kind]),
    all: vi.fn(() => new Map(Object.entries(adapterMap))),
  };
  const service = new LessonSpendService(
    em,
    usage as unknown as UsageEventDao,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    runDao as unknown as RunDao,
    registry as unknown as AgentAdapterRegistry,
  );
  return { service, usage, segments, proposals };
}

describe('LessonSpendService.spend', () => {
  it('reads reflection and check usage rows from the start of the month', async () => {
    const { service, usage } = build();

    await service.spend(NOW);

    expect(usage.ofPurposesSince).toHaveBeenCalledWith(
      ['lessons', 'lessons_check'],
      new Date(2026, 10, 1),
      expect.anything(),
    );
  });

  it('splits reflect and check spend, today from the month', async () => {
    const { service } = build({
      usage: [
        row({ purpose: 'lessons', costUsd: 0.5 }),
        row({ purpose: 'lessons_check', costUsd: 0.25 }),
        row({ purpose: 'lessons', costUsd: 1, occurredAt: EARLIER_THIS_MONTH }),
        row({
          purpose: 'lessons_check',
          costUsd: 2,
          occurredAt: EARLIER_THIS_MONTH,
        }),
      ],
    });

    const spend = await service.spend(NOW);

    expect(spend.todayByStep).toEqual({ reflect: 0.5, check: 0.25 });
    expect(spend.monthByStep).toEqual({ reflect: 1.5, check: 2.25 });
    expect(spend.todayUsd).toBe(0.75);
    expect(spend.monthUsd).toBe(3.75);
  });

  it('counts a run whose rows all have no cost as unpriced, not as zero spend', async () => {
    const { service } = build({
      usage: [
        row({ runId: 'unpriced', costUsd: null }),
        row({ runId: 'unpriced', costUsd: null, purpose: 'lessons_check' }),
        row({ runId: 'priced', costUsd: 0.2 }),
      ],
    });

    const spend = await service.spend(NOW);

    expect(spend.unpricedRuns).toBe(1);
    expect(spend.todayUsd).toBeCloseTo(0.2);
  });

  it('does not call a run unpriced when any of its rows carries a cost', async () => {
    const { service } = build({
      usage: [
        row({ runId: 'mixed', costUsd: null }),
        row({ runId: 'mixed', costUsd: 0.3 }),
      ],
    });

    expect((await service.spend(NOW)).unpricedRuns).toBe(0);
  });

  it('counts the distinct threads reflected today and the lessons saved today', async () => {
    const { service, segments, proposals } = build({
      ended: [{ runId: 'a' }, { runId: 'a' }, { runId: 'b' }],
      saved: 4,
    });

    const spend = await service.spend(NOW);

    expect(spend.reflectedToday).toBe(2);
    expect(spend.savedToday).toBe(4);
    expect(segments.listChangedSince).toHaveBeenCalledWith(
      ['reflected', 'empty'],
      new Date(2026, 10, 15),
      expect.anything(),
    );
    expect(proposals.savedSince).toHaveBeenCalledWith(
      new Date(2026, 10, 15),
      expect.anything(),
    );
  });

  it('lists failed segments with their thread title and reason', async () => {
    const { service, segments } = build({
      failed: [
        { id: 's1', runId: 'a', failReason: 'the CLI timed out' },
        { id: 's2', runId: 'gone', failReason: null },
      ],
      titles: { a: 'Migrate the cache' },
    });

    const spend = await service.spend(NOW);

    expect(segments.listByStatus).toHaveBeenCalledWith(
      ['failed'],
      null,
      expect.anything(),
    );
    expect(spend.failed).toEqual([
      {
        segmentId: 's1',
        runId: 'a',
        sourceTitle: 'Migrate the cache',
        reason: 'the CLI timed out',
        cause: 'other',
        resetsAt: null,
      },
      {
        segmentId: 's2',
        runId: 'gone',
        sourceTitle: null,
        reason: null,
        cause: 'other',
        resetsAt: null,
      },
    ]);
  });

  it('classifies a usage-limit message as limit and keeps the reset as written', async () => {
    const { service } = build({
      failed: [
        {
          id: 's1',
          runId: 'a',
          failReason: "You've hit your weekly limit · resets 4pm (Asia/Almaty)",
        },
      ],
    });

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'limit', resetsAt: '4pm' });
  });

  it('classifies a lapsed sign-in as signed_out with no reset', async () => {
    const { service } = build({
      failed: [
        {
          id: 's1',
          runId: 'a',
          failReason: 'Failed to authenticate. Run `claude auth login`',
        },
      ],
    });

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'signed_out', resetsAt: null });
  });

  it('classifies an unrecognised message as other', async () => {
    const { service } = build({
      failed: [{ id: 's1', runId: 'a', failReason: 'segfault' }],
    });

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'other', resetsAt: null });
  });

  it('asks only the reflection run’s own adapter when its agent is known', async () => {
    const codexLike = fakeAdapter(() => ({
      class: 'rate_limited',
      resetsAt: 'tomorrow',
    }));
    const { service } = build({
      adapters: { claude: claudeLike, codex: codexLike },
      reflectionKinds: { refl: 'claude' },
      failed: [
        {
          id: 's1',
          runId: 'a',
          reflectionRunId: 'refl',
          failReason: 'segfault',
        },
      ],
    });
    codexLike.failureFrom.mockClear();

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'other', resetsAt: null });
    expect(codexLike.failureFrom).not.toHaveBeenCalled();
  });

  it('asks every adapter when the reflection run is unknown', async () => {
    const codexLike = fakeAdapter(() => ({
      class: 'rate_limited',
      resetsAt: 'tomorrow',
    }));
    const { service } = build({
      adapters: { claude: claudeLike, codex: codexLike },
      failed: [
        {
          id: 's1',
          runId: 'a',
          reflectionRunId: 'missing',
          failReason: 'segfault',
        },
      ],
    });

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'limit', resetsAt: 'tomorrow' });
  });

  it('asks every adapter when the reflection run’s agent has no adapter any more', async () => {
    const { service } = build({
      adapters: { claude: claudeLike },
      reflectionKinds: { refl: 'cursor-agent' },
      failed: [
        {
          id: 's1',
          runId: 'a',
          reflectionRunId: 'refl',
          failReason: "You've hit your weekly limit · resets 4pm",
        },
      ],
    });

    const [item] = (await service.spend(NOW)).failed;

    expect(item).toMatchObject({ cause: 'limit', resetsAt: '4pm' });
  });

  it('names at most five failed segments', async () => {
    const { service } = build({
      failed: Array.from({ length: 7 }, (_, n) => ({
        id: `s${n}`,
        runId: `r${n}`,
        failReason: 'x',
      })),
    });

    expect((await service.spend(NOW)).failed).toHaveLength(5);
  });
});

describe('LessonSpendService.typical', () => {
  it('sums each finished run’s reflection and check from the ledger and takes the median over runs on the model asked for', async () => {
    const { service, usage } = build({
      finished: [
        { id: 's1', reflectionRunId: 'refl-1', checkRunId: 'check-1' },
        { id: 's2', reflectionRunId: 'refl-2', checkRunId: null },
        { id: 's3', reflectionRunId: 'refl-3', checkRunId: null },
        { id: 's4', reflectionRunId: null, checkRunId: null },
      ],
      ledger: [
        {
          runId: 'refl-1',
          model: 'sonnet-x',
          costUsd: 0.2,
          durationMs: 20_000,
        },
        { runId: 'refl-1', model: 'sonnet-x', costUsd: 0.1, durationMs: 5_000 },
        { runId: 'check-1', model: 'opus-x', costUsd: 0.05, durationMs: 5_000 },
        {
          runId: 'refl-2',
          model: 'sonnet-x',
          costUsd: 0.5,
          durationMs: 50_000,
        },
        {
          runId: 'refl-3',
          model: 'sonnet-x',
          costUsd: null,
          durationMs: 40_000,
        },
      ],
    });

    expect(await service.typical('sonnet-x')).toEqual({
      runs: 3,
      usd: expect.closeTo(0.425, 10),
      durationMs: 40_000,
      model: 'sonnet-x',
      sameModel: true,
    });
    expect(usage.rowsByRuns).toHaveBeenCalledWith(
      ['refl-1', 'check-1', 'refl-2', 'refl-3'],
      expect.anything(),
    );
  });

  it('answers null before any run finished', async () => {
    const { service } = build();

    expect(await service.typical('sonnet-x')).toBeNull();
  });
});
