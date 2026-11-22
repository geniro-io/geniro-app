import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import { BackgroundJobsRegistry } from '../../background-jobs/services/background-jobs.registry';
import type { MemoryService } from '../../memory/services/memory.service';
import { UsageEventBus } from '../../stats/services/usage-events.bus';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonRunSample } from '../utils/typical-spend';
import { LessonBackgroundJobSource } from './lesson-background-jobs.source';
import type { LessonSpendService } from './lesson-spend.service';
import { LessonsEventBus } from './lessons-events.bus';

function segment(
  id: string,
  status: LessonSegment['status'],
  extra: Partial<LessonSegment> = {},
): LessonSegment {
  return {
    id,
    runId: `run-${id}`,
    status,
    closedAt: new Date('2026-11-22T10:00:00.000Z'),
    updatedAt: new Date('2026-11-22T10:01:00.000Z'),
    reflectionRunId: `refl-${id}`,
    checkRunId: null,
    failReason: null,
    ...extra,
  } as LessonSegment;
}

function proposal(
  id: string,
  segmentId: string,
  status: LessonProposal['status'],
): LessonProposal {
  return { id, segmentId, status } as LessonProposal;
}

function build(options: {
  active?: LessonSegment[];
  finished?: LessonSegment[];
  proposals?: LessonProposal[];
  pending?: string[];
  samples?: Record<string, LessonRunSample>;
}) {
  const segments = {
    listByStatus: vi.fn(() => Promise.resolve(options.active ?? [])),
    page: vi.fn(() => Promise.resolve(options.finished ?? [])),
  };
  const proposals = {
    ofSegments: vi.fn(() => Promise.resolve(options.proposals ?? [])),
  };
  const runDao = {
    titlesOf: vi.fn((ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, `Title of ${id}`]))),
    ),
    getById: vi.fn((id: string) =>
      Promise.resolve(
        id.startsWith('refl-')
          ? { id, analysisPurpose: 'lessons' }
          : id.startsWith('check-')
            ? { id, analysisPurpose: 'lessons_check' }
            : { id, analysisPurpose: null },
      ),
    ),
  };
  const spending = {
    samplesOf: vi.fn(() =>
      Promise.resolve(new Map(Object.entries(options.samples ?? {}))),
    ),
  };
  const memory = {
    pendingLessonProposals: vi.fn(() =>
      Promise.resolve(new Set(options.pending ?? [])),
    ),
  };
  const registry = new BackgroundJobsRegistry();
  const events = new LessonsEventBus();
  const usage = new UsageEventBus();
  const source = new LessonBackgroundJobSource(
    { fork: () => ({}) } as unknown as EntityManager,
    registry,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    runDao as unknown as RunDao,
    spending as unknown as LessonSpendService,
    memory as unknown as MemoryService,
    events,
    usage,
  );
  source.onModuleInit();
  return { source, registry, events, usage, segments };
}

describe('LessonBackgroundJobSource', () => {
  it('lists queued and working stretches as active jobs, a working one with what it is doing', async () => {
    const h = build({
      active: [segment('a', 'queued'), segment('b', 'checking')],
    });

    const list = await h.registry.list({ limit: 5 });

    expect(h.segments.listByStatus).toHaveBeenCalledWith(
      ['queued', 'reflecting', 'checking'],
      null,
      expect.anything(),
    );
    expect(list.active).toEqual([
      expect.objectContaining({
        id: 'lessons:b',
        status: 'running',
        phase: 'checking',
        endedAt: null,
        lessons: null,
      }),
      expect.objectContaining({ id: 'lessons:a', status: 'queued' }),
    ]);
    expect(list.running).toBe(2);
  });

  it('counts what a finished run filed: saved, waiting for review and dropped', async () => {
    const h = build({
      finished: [segment('a', 'reflected')],
      proposals: [
        proposal('p1', 'a', 'saved'),
        proposal('p2', 'a', 'saved'),
        proposal('p3', 'a', 'proposed'),
        proposal('p4', 'a', 'dropped_by_check'),
        proposal('p5', 'a', 'rejected'),
      ],
      pending: ['p2'],
      samples: {
        a: { model: 'claude-sonnet-5-5', usd: 0.28, durationMs: 34_000 },
      },
    });

    const [job] = (await h.registry.list({ limit: 5 })).finished;

    expect(job).toMatchObject({
      id: 'lessons:a',
      kind: 'lessons',
      status: 'done',
      runId: 'run-a',
      title: 'Title of run-a',
      startedAt: '2026-11-22T10:00:00.000Z',
      endedAt: '2026-11-22T10:01:00.000Z',
      model: 'claude-sonnet-5-5',
      costUsd: 0.28,
      durationMs: 34_000,
      error: null,
      lessons: { saved: 1, waiting: 2, dropped: 1 },
    });
  });

  it('says why a failed run failed and that an empty one found nothing', async () => {
    const h = build({
      finished: [
        segment('f', 'failed', {
          failReason: "You've hit your weekly limit",
        }),
        segment('e', 'empty', {
          closedAt: new Date('2026-11-22T09:00:00.000Z'),
        }),
      ],
    });

    const { finished } = await h.registry.list({ limit: 5 });

    expect(finished).toEqual([
      expect.objectContaining({
        id: 'lessons:f',
        status: 'failed',
        error: "You've hit your weekly limit",
        lessons: null,
        costUsd: null,
      }),
      expect.objectContaining({
        id: 'lessons:e',
        status: 'done',
        lessons: { saved: 0, waiting: 0, dropped: 0 },
      }),
    ]);
  });

  it('never lists a stretch the user skipped', async () => {
    const h = build({});

    await h.registry.list({ limit: 5 });

    expect(h.segments.page).toHaveBeenCalledWith(
      ['reflected', 'empty', 'failed'],
      null,
      expect.any(Number),
      expect.anything(),
    );
  });

  it('turns every lessons change into a background jobs change', () => {
    const h = build({});
    const seen: string[] = [];
    h.registry.allChanges().subscribe((change) => seen.push(change.kind));

    h.events.publishChanged('run-a');

    expect(seen).toEqual(['lessons']);
  });

  it('announces a change when a lessons run’s cost lands after it ended, and not for any other run', async () => {
    const h = build({});
    const seen: string[] = [];
    h.registry.allChanges().subscribe((change) => seen.push(change.kind));
    const recorded = (runId: string): void =>
      h.usage.publish({
        runId,
        memberId: null,
        occurredAt: '2026-11-22T10:01:02.000Z',
        turn: true,
      });

    recorded('refl-a');
    recorded('check-a');
    recorded('chat-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(seen).toEqual(['lessons', 'lessons']);
  });
});
