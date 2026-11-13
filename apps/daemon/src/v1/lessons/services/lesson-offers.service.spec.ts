import type { EntityManager } from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonEstimate, LessonSegmentStatus } from '../lessons.types';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonOffersService } from './lesson-offers.service';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsEventBus } from './lessons-events.bus';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

const ESTIMATE: LessonEstimate = {
  agentKind: 'claude',
  model: 'claude-haiku-5-5',
  tokens: 12_000,
  usd: 0.03,
};

function runOf(overrides: Partial<Run> = {}): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

function segmentOf(overrides: Partial<LessonSegment> = {}): LessonSegment {
  return {
    id: 'seg-1',
    runId: 'src',
    fromSeq: -1,
    toSeq: 2,
    closedBy: 'idle',
    closedAt: new Date('2026-11-13T10:00:00.000Z'),
    signals: JSON.stringify([
      { kind: 'user_correction', seq: 2, excerpt: 'no, that is wrong' },
    ]),
    status: 'offered',
    reflectionRunId: null,
    attempts: 0,
    ...overrides,
  } as unknown as LessonSegment;
}

function build(
  options: {
    runs?: Run[];
    segments?: LessonSegment[];
    items?: Record<string, Item[]>;
    maxSeq?: number;
    startFails?: string[];
    /** The lessons reflections on the thread, as `listLessonReflectionsOf` finds them. */
    reflections?: { status: string }[];
  } = {},
) {
  const runs = new Map((options.runs ?? [runOf()]).map((run) => [run.id, run]));
  const stored = new Map((options.segments ?? []).map((seg) => [seg.id, seg]));
  const itemsOf = (runId: string): Item[] => options.items?.[runId] ?? [];

  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn((runId: string) => Promise.resolve(runs.get(runId) ?? null)),
    listLessonReflectionsOf: vi.fn(() =>
      Promise.resolve((options.reflections ?? []) as Run[]),
    ),
  };
  const itemDao = {
    maxSeqExcept: vi.fn((runId: string) =>
      Promise.resolve(
        options.maxSeq ??
          Math.max(-1, ...itemsOf(runId).map((item) => item.seq)),
      ),
    ),
    analysisPage: vi.fn(
      (
        runId: string,
        page: {
          afterSeq: number;
          maxSeq: number;
          limit: number;
          kinds?: readonly string[];
        },
      ) =>
        Promise.resolve(
          itemsOf(runId).filter(
            (item) =>
              item.seq > page.afterSeq &&
              item.seq <= page.maxSeq &&
              (page.kinds === undefined || page.kinds.includes(item.kind)),
          ),
        ),
    ),
  };
  const segments = {
    listByStatus: vi.fn(
      (statuses: readonly LessonSegmentStatus[], runId: string | null) =>
        Promise.resolve(
          [...stored.values()].filter(
            (seg) =>
              statuses.includes(seg.status) &&
              (runId === null || seg.runId === runId),
          ),
        ),
    ),
    getById: vi.fn((id: string) => Promise.resolve(stored.get(id) ?? null)),
    updateById: vi.fn((id: string, fields: Partial<LessonSegment>) => {
      Object.assign(stored.get(id)!, fields);
      return Promise.resolve();
    }),
  };
  const estimates = {
    estimate: vi.fn(() => Promise.resolve(ESTIMATE)),
  };
  const reflections = {
    start: vi.fn((runId: string, input: { segmentId?: string }) => {
      const refused = options.startFails?.includes(input.segmentId ?? '');
      return refused
        ? Promise.reject(new Error(`refused ${runId}`))
        : Promise.resolve({
            reflectionRunId: `refl-${runId}`,
            segmentId: input.segmentId ?? '',
            fromSeq: -1,
            toSeq: 2,
          });
    }),
  };
  const events = new LessonsEventBus();
  const service = new LessonOffersService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    segments as unknown as LessonSegmentDao,
    estimates as unknown as LessonEstimateService,
    reflections as unknown as LessonReflectionService,
    events,
  );
  return {
    service,
    em,
    runDao,
    itemDao,
    segments,
    estimates,
    reflections,
    events,
  };
}

describe('LessonOffersService.list', () => {
  it('lists the offered, dismissed and failed stretches when no status is named', async () => {
    const h = build();

    await h.service.list({});

    expect(h.segments.listByStatus).toHaveBeenCalledWith(
      ['offered', 'dismissed', 'failed'],
      null,
      h.em,
    );
  });

  it('lists the statuses the query names, trimmed, and the one thread it names', async () => {
    const h = build();

    await h.service.list({ status: 'offered, reflected', runId: 'src' });

    expect(h.segments.listByStatus).toHaveBeenCalledWith(
      ['offered', 'reflected'],
      'src',
      h.em,
    );
  });

  it('refuses a status the lessons do not have, with 400 INVALID_SEGMENT_STATUS', async () => {
    const h = build();

    const failure = h.service.list({ status: 'offered,stale' });

    await expect(failure).rejects.toBeInstanceOf(BadRequestException);
    await expect(failure).rejects.toMatchObject({
      errorCode: 'INVALID_SEGMENT_STATUS',
    });
    expect(h.segments.listByStatus).not.toHaveBeenCalled();
  });

  it('leaves a thread being deleted out of the all-threads list', async () => {
    const h = build({
      runs: [runOf({ id: 'gone', pendingDeleteAt: new Date() })],
      segments: [segmentOf({ id: 'seg-gone', runId: 'gone' })],
    });

    await expect(h.service.list({})).resolves.toEqual([]);
  });

  it('keeps a thread being deleted in the list of that one thread', async () => {
    const h = build({
      runs: [runOf({ id: 'gone', pendingDeleteAt: new Date() })],
      segments: [segmentOf({ id: 'seg-gone', runId: 'gone' })],
    });

    await expect(h.service.list({ runId: 'gone' })).resolves.toHaveLength(1);
  });

  it('shapes each stretch for the wire: its title, archive flag, signals and its price', async () => {
    const h = build({
      runs: [runOf({ archivedAt: new Date() })],
      segments: [
        segmentOf({
          signals: JSON.stringify([
            { kind: 'user_correction', seq: 2, excerpt: 'no' },
            { kind: 'not_a_signal', seq: 3, excerpt: 'x' },
          ]),
        }),
      ],
    });

    const [wire] = await h.service.list({});

    expect(wire).toEqual({
      id: 'seg-1',
      runId: 'src',
      sourceTitle: 'Migrate the cache',
      archived: true,
      fromSeq: -1,
      toSeq: 2,
      closedBy: 'idle',
      closedAt: '2026-11-13T10:00:00.000Z',
      signals: [{ kind: 'user_correction', seq: 2 }],
      status: 'offered',
      reflectionRunId: null,
      estimate: ESTIMATE,
    });
    expect(h.estimates.estimate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src' }),
      { fromSeq: -1, toSeq: 2 },
      {},
      h.em,
    );
  });
});

describe('LessonOffersService.dismiss', () => {
  it('puts an offered stretch aside as dismissed and announces the change', async () => {
    const h = build({ segments: [segmentOf()] });
    const announced: (string | null)[] = [];
    h.events.allChanges().subscribe((event) => announced.push(event.runId));

    const wire = await h.service.dismiss('seg-1');

    expect(h.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'dismissed' },
      h.em,
    );
    expect(wire.status).toBe('dismissed');
    expect(announced).toEqual(['src']);
  });

  it.each(['dismissed', 'reflecting', 'reflected', 'failed', 'empty'] as const)(
    'refuses a stretch that is already %s, with 409 LESSON_SEGMENT_DECIDED',
    async (status) => {
      const h = build({ segments: [segmentOf({ status })] });

      await expect(h.service.dismiss('seg-1')).rejects.toMatchObject({
        errorCode: 'LESSON_SEGMENT_DECIDED',
      });
      expect(h.segments.updateById).not.toHaveBeenCalled();
    },
  );

  it('refuses a stretch that does not exist, with 404 LESSON_SEGMENT_NOT_FOUND', async () => {
    const h = build();

    await expect(h.service.dismiss('missing')).rejects.toMatchObject({
      errorCode: 'LESSON_SEGMENT_NOT_FOUND',
    });
  });
});

describe('LessonOffersService.reflectAll', () => {
  it('starts one reflection per waiting stretch, on its own segment, and counts the refusals', async () => {
    const h = build({
      segments: [
        segmentOf({ id: 'seg-a', runId: 'a' }),
        segmentOf({ id: 'seg-b', runId: 'b' }),
        segmentOf({ id: 'seg-c', runId: 'c' }),
      ],
      runs: [runOf({ id: 'a' }), runOf({ id: 'b' }), runOf({ id: 'c' })],
      startFails: ['seg-b'],
    });

    await expect(h.service.reflectAll()).resolves.toEqual({
      started: 2,
      refused: 1,
    });

    expect(h.reflections.start).toHaveBeenCalledTimes(3);
    expect(h.reflections.start).toHaveBeenCalledWith('a', {
      segmentId: 'seg-a',
    });
    expect(h.reflections.start).toHaveBeenCalledWith('b', {
      segmentId: 'seg-b',
    });
    expect(h.reflections.start).toHaveBeenCalledWith('c', {
      segmentId: 'seg-c',
    });
  });

  it('starts nothing and counts nothing when no stretch waits', async () => {
    const h = build();

    await expect(h.service.reflectAll()).resolves.toEqual({
      started: 0,
      refused: 0,
    });
    expect(h.reflections.start).not.toHaveBeenCalled();
  });
});

describe('LessonOffersService.threadEstimate', () => {
  it('counts the learning signals past the watermark and prices them now', async () => {
    const h = build({
      runs: [runOf({ reflectedThroughSeq: 2 })],
      items: {
        src: [
          { seq: 1, kind: 'message', role: 'user', payload: '{"text":"no"}' },
          { seq: 2, kind: 'turn_complete', role: null, payload: '{}' },
          { seq: 3, kind: 'turn_complete', role: null, payload: '{}' },
          {
            seq: 4,
            kind: 'message',
            role: 'user',
            payload: '{"text":"no, still wrong"}',
          },
        ],
      },
      maxSeq: 5,
    });

    const result = await h.service.threadEstimate({ runId: 'src' });

    expect(result).toEqual({
      estimate: ESTIMATE,
      signals: 1,
      fromSeq: 2,
      toSeq: 5,
    });
    expect(h.estimates.estimate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'src' }),
      { fromSeq: 2, toSeq: 5 },
      { runId: 'src' },
      h.em,
    );
  });

  it('counts zero signals when nothing is past the watermark', async () => {
    const h = build({
      runs: [runOf({ reflectedThroughSeq: 4 })],
      items: {
        src: [
          { seq: 4, kind: 'message', role: 'user', payload: '{"text":"no"}' },
        ],
      },
      maxSeq: 4,
    });

    const result = await h.service.threadEstimate({ runId: 'src' });

    expect(result).toMatchObject({ signals: 0, fromSeq: 4, toSeq: 4 });
    expect(h.itemDao.analysisPage).not.toHaveBeenCalled();
    expect(h.estimates.estimate).toHaveBeenCalledWith(
      expect.anything(),
      { fromSeq: 4, toSeq: 4 },
      expect.anything(),
      h.em,
    );
  });

  it.each([
    ['an analysis', { analysisSourceRunId: 'other' }],
    ['a thread being deleted', { pendingDeleteAt: new Date() }],
  ])(
    'counts zero signals for %s, and still prices it',
    async (_, overrides) => {
      const h = build({
        runs: [runOf({ reflectedThroughSeq: 2, ...overrides })],
        items: {
          src: [
            { seq: 3, kind: 'turn_complete', role: null, payload: '{}' },
            {
              seq: 4,
              kind: 'message',
              role: 'user',
              payload: '{"text":"no, still wrong"}',
            },
          ],
        },
        maxSeq: 5,
      });

      const result = await h.service.threadEstimate({ runId: 'src' });

      expect(result).toMatchObject({ signals: 0, fromSeq: 2, toSeq: 5 });
      expect(h.itemDao.analysisPage).not.toHaveBeenCalled();
      expect(h.estimates.estimate).toHaveBeenCalledTimes(1);
    },
  );

  it('counts zero signals while a reflection on the thread still runs, and the signals again once it has finished', async () => {
    const items = {
      src: [
        { seq: 3, kind: 'turn_complete', role: null, payload: '{}' },
        {
          seq: 4,
          kind: 'message',
          role: 'user',
          payload: '{"text":"no, still wrong"}',
        },
      ],
    };
    const working = build({
      runs: [runOf({ reflectedThroughSeq: 2 })],
      items,
      maxSeq: 5,
      reflections: [{ status: 'running' }],
    });
    const finished = build({
      runs: [runOf({ reflectedThroughSeq: 2 })],
      items,
      maxSeq: 5,
      reflections: [{ status: 'completed' }],
    });

    await expect(
      working.service.threadEstimate({ runId: 'src' }),
    ).resolves.toMatchObject({ signals: 0 });
    await expect(
      finished.service.threadEstimate({ runId: 'src' }),
    ).resolves.toMatchObject({ signals: 1 });
  });

  it('refuses a thread that does not exist, with 404 RUN_NOT_FOUND', async () => {
    const h = build({ runs: [] });

    await expect(
      h.service.threadEstimate({ runId: 'nope' }),
    ).rejects.toMatchObject({
      errorCode: 'RUN_NOT_FOUND',
    });
  });
});
