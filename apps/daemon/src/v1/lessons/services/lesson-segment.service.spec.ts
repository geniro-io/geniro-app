import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  RunItemEvent,
  RunWire,
  StageProgress,
  ThreadOutcome,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { RunStatus } from '../../runs/runs.types';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import type { TaskChangedEvent } from '../../tasks/tasks.types';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import {
  DEFAULT_LESSONS_CONFIG,
  LESSON_DONE_QUIET_MS,
  type LessonsConfig,
} from '../lessons.types';
import type { LessonEstimateService } from './lesson-estimate.service';
import type { LessonRowWriter } from './lesson-row.writer';
import {
  LESSON_BOOT_SWEEP_DELAY_MS,
  LessonSegmentService,
} from './lesson-segment.service';
import { LessonsConfigService } from './lessons-config.service';

const HOUR_MS = 3_600_000;

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

type Written = {
  runId: string;
  kind: string;
  payload: Record<string, unknown>;
};

function userMessage(seq: number, text: string): Item {
  return {
    seq,
    kind: 'message',
    role: 'user',
    payload: JSON.stringify({ text }),
  };
}

function turnComplete(seq: number): Item {
  return { seq, kind: 'turn_complete', role: null, payload: '{}' };
}

/** A finished turn and a push-back on it: a learning signal in the stretch. */
function correctionStretch(): Item[] {
  return [turnComplete(1), userMessage(2, 'no, that is wrong')];
}

function runOf(overrides: Partial<Run> = {}): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    teamId: null,
    teamSnapshot: null,
    projectId: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Run;
}

function recordedOutcome(): ThreadOutcome {
  return { kind: 'success', summary: null, source: 'recorded', seq: 5 };
}

function goalsOutcome(): ThreadOutcome {
  return { kind: 'success', summary: null, source: 'goals', seq: null };
}

function userMessageEvent(runId: string): RunItemEvent {
  return {
    runId,
    item: { kind: 'message', role: 'user' } as unknown as RunItemEvent['item'],
  };
}

function stagesAt(current: string | null): StageProgress {
  return {
    rev: 4,
    current,
    position: { index: 1, total: 2 },
    stages: [
      { id: 'build', title: 'Build', status: 'done', next: ['review'] },
      {
        id: 'review',
        title: 'Review',
        status: current === null ? 'done' : 'current',
        next: [],
      },
    ],
  };
}

function build(
  options: {
    runs?: Run[];
    items?: Record<string, Item[]>;
    config?: Partial<LessonsConfig>;
    project?: { lessons: 'on' | 'off' | null } | null;
    teamLessons?: 'on' | 'off' | null;
    cardRuns?: Run[];
    candidates?: Run[];
  } = {},
) {
  const runs = new Map((options.runs ?? [runOf()]).map((run) => [run.id, run]));
  const items = new Map(Object.entries(options.items ?? {}));
  const itemsOf = (runId: string): Item[] => items.get(runId) ?? [];

  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn((runId: string) => Promise.resolve(runs.get(runId) ?? null)),
    listOfTask: vi.fn(() => Promise.resolve(options.cardRuns ?? [])),
    listLessonCandidates: vi.fn(() =>
      Promise.resolve(options.candidates ?? []),
    ),
    listLessonReflectionsOf: vi.fn(() => Promise.resolve([])),
  };
  const itemDao = {
    maxSeqExcept: vi.fn((runId: string) =>
      Promise.resolve(Math.max(-1, ...itemsOf(runId).map((item) => item.seq))),
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
          itemsOf(runId)
            .filter(
              (item) =>
                item.seq > page.afterSeq &&
                item.seq <= page.maxSeq &&
                (page.kinds === undefined || page.kinds.includes(item.kind)),
            )
            .slice(0, page.limit),
        ),
    ),
  };

  const created: Record<string, unknown>[] = [];
  const updated: { id: string; fields: Record<string, unknown> }[] = [];
  const stored = new Map<string, Record<string, unknown>>();
  const segments = {
    openOf: vi.fn((runId: string) =>
      Promise.resolve(
        [...stored.values()]
          .filter(
            (segment) =>
              segment.runId === runId && segment.status === 'offered',
          )
          .at(-1) ?? null,
      ),
    ),
    create: vi.fn((input: Record<string, unknown>) => {
      const segment = { id: `seg-${created.length + 1}`, ...input };
      created.push(input);
      stored.set(segment.id as string, segment);
      return Promise.resolve(segment);
    }),
    updateById: vi.fn((id: string, fields: Record<string, unknown>) => {
      updated.push({ id, fields });
      Object.assign(stored.get(id)!, fields);
      return Promise.resolve();
    }),
  };

  const written: Written[] = [];
  const rows = {
    write: vi.fn((runId: string, row: { kind: string; payload: unknown }) => {
      written.push({
        runId,
        kind: row.kind,
        payload: row.payload as Record<string, unknown>,
      });
      return Promise.resolve();
    }),
  };

  const estimates = {
    estimate: vi.fn(() =>
      Promise.resolve({
        agentKind: 'claude',
        model: 'claude-haiku-5-5',
        tokens: 9_000,
        usd: 0.02,
      }),
    ),
  };

  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const teams = {
    get: vi.fn(() =>
      Promise.resolve({ team: { lessons: options.teamLessons ?? null } }),
    ),
  };

  const config = new LessonsConfigService();
  config.set({ ...DEFAULT_LESSONS_CONFIG, ...options.config });

  const bus = new AgentEventBus();
  const tasks = new TaskEventBus();
  const service = new LessonSegmentService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    bus,
    tasks,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    estimates as unknown as LessonEstimateService,
    rows as unknown as LessonRowWriter,
    config,
    teams as unknown as TeamStoreService,
  );
  return {
    service,
    bus,
    tasks,
    runs,
    items,
    created,
    updated,
    written,
    runDao,
    segments,
    estimates,
    projectScope,
    teams,
    config,
  };
}

/** Lets the close chain's awaited reads and writes finish, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('LessonSegmentService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('archive', () => {
    it('closes an archived thread at once and writes its lesson_offer row', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunsChanged([
        {
          id: 'src',
          archivedAt: '2026-11-13T10:00:00.000Z',
        } as unknown as RunWire,
      ]);
      await settle();

      expect(h.created).toEqual([
        expect.objectContaining({
          runId: 'src',
          closedBy: 'archive',
          status: 'offered',
          fromSeq: -1,
          toSeq: 2,
        }),
      ]);
      expect(h.written).toEqual([
        {
          runId: 'src',
          kind: 'lesson_offer',
          payload: expect.objectContaining({
            segmentId: 'seg-1',
            closedBy: 'archive',
            fromSeq: -1,
            toSeq: 2,
            signals: [{ kind: 'user_correction', seq: 2 }],
          }),
        },
      ]);
      expect(h.service.waiting('src')).toBeNull();
    });

    it('writes nothing for an archived thread with no learning signal in it', async () => {
      const h = build({
        items: { src: [turnComplete(1), userMessage(2, 'thanks, looks good')] },
      });
      h.service.onModuleInit();

      h.bus.publishRunsChanged([
        {
          id: 'src',
          archivedAt: '2026-11-13T10:00:00.000Z',
        } as unknown as RunWire,
      ]);
      await settle();

      expect(h.created).toEqual([]);
      expect(h.written).toEqual([]);
    });

    it('takes over a waiting done close: one offer, and none at the 10-minute mark', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        outcome: recordedOutcome(),
      });
      expect(h.service.waiting('src')).toBe('done');

      h.bus.publishRunsChanged([
        {
          id: 'src',
          archivedAt: '2026-11-13T10:00:00.000Z',
        } as unknown as RunWire,
      ]);
      await settle();
      expect(h.service.waiting('src')).toBeNull();

      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS);
      await settle();
      expect(h.created).toHaveLength(1);
      expect(h.created[0]).toEqual(
        expect.objectContaining({ closedBy: 'archive' }),
      );
    });
  });

  describe('done close: a recorded outcome, a final stage, a finished card', () => {
    it('closes the stretch after LESSON_DONE_QUIET_MS and not before', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        outcome: recordedOutcome(),
      });
      expect(h.service.waiting('src')).toBe('done');

      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS - 1);
      await settle();
      expect(h.created).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.created).toEqual([
        expect.objectContaining({ runId: 'src', closedBy: 'done' }),
      ]);
      expect(h.written).toHaveLength(1);
      expect(h.written[0]?.kind).toBe('lesson_offer');
    });

    it('a goals-derived outcome arms nothing', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        outcome: goalsOutcome(),
      });
      expect(h.service.waiting('src')).toBeNull();

      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS);
      await settle();
      expect(h.created).toEqual([]);
      expect(h.written).toEqual([]);
    });

    it('a user message cancels a waiting done close', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        outcome: recordedOutcome(),
      });
      h.bus.publish(userMessageEvent('src'));
      expect(h.service.waiting('src')).toBeNull();

      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS);
      await settle();
      expect(h.created).toEqual([]);
    });

    it('a final stage (no current stage left) arms the done close', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        stages: stagesAt(null),
      });
      expect(h.service.waiting('src')).toBe('done');
    });

    it('a stage still in progress arms nothing', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        stages: stagesAt('review'),
      });
      expect(h.service.waiting('src')).toBeNull();
    });

    it.each(['in_review', 'done'] as const)(
      'a card moved to %s arms the done close of its runs',
      async (status) => {
        const h = build({
          items: { src: correctionStretch() },
          cardRuns: [runOf({ id: 'src' })],
        });
        h.service.onModuleInit();

        h.tasks.publishTaskChanged({
          taskId: 'task-1',
          projectId: 'project-1',
          status,
        } as TaskChangedEvent);
        await settle();

        expect(h.runDao.listOfTask).toHaveBeenCalledWith(
          'task-1',
          expect.anything(),
        );
        expect(h.service.waiting('src')).toBe('done');
      },
    );

    it('a card moved to a status still in progress arms nothing', async () => {
      const h = build({
        items: { src: correctionStretch() },
        cardRuns: [runOf({ id: 'src' })],
      });
      h.service.onModuleInit();

      h.tasks.publishTaskChanged({
        taskId: 'task-1',
        projectId: 'project-1',
        status: 'in_progress',
      } as TaskChangedEvent);
      await settle();

      expect(h.service.waiting('src')).toBeNull();
    });

    it('a card move skips an archived run of the card', async () => {
      const h = build({
        items: { src: correctionStretch() },
        cardRuns: [runOf({ id: 'src', archivedAt: new Date() })],
      });
      h.service.onModuleInit();

      h.tasks.publishTaskChanged({
        taskId: 'task-1',
        projectId: 'project-1',
        status: 'done',
      } as TaskChangedEvent);
      await settle();

      expect(h.service.waiting('src')).toBeNull();
    });
  });

  describe('idle close after a settle', () => {
    it('a normal settle arms the idle close at quietWindowHours and not before', async () => {
      const h = build({
        items: { src: correctionStretch() },
        config: { quietWindowHours: 1 },
      });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      expect(h.service.waiting('src')).toBe('idle');

      await vi.advanceTimersByTimeAsync(HOUR_MS - 1);
      await settle();
      expect(h.created).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.created).toEqual([
        expect.objectContaining({ runId: 'src', closedBy: 'idle' }),
      ]);
    });

    it.each([
      {
        name: 'a turn geniro started itself (hostTurn)',
        flag: { hostTurn: true },
      },
      { name: 'a status handed back (restored)', flag: { restored: true } },
      { name: 'a housekeeping turn', flag: { housekeeping: true } },
    ])('a settle that is $name does not arm one', ({ flag }) => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed', ...flag });

      expect(h.service.waiting('src')).toBeNull();
    });

    it('a run that is still working arms nothing', () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'running' as RunStatus });

      expect(h.service.waiting('src')).toBeNull();
    });

    it('a user message cancels a waiting idle close', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      h.bus.publish(userMessageEvent('src'));
      expect(h.service.waiting('src')).toBeNull();

      await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
      await settle();
      expect(h.created).toEqual([]);
    });

    it('a deleted thread drops its waiting close', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      h.bus.publishRunDeleted('src');
      expect(h.service.waiting('src')).toBeNull();
    });

    it('a settle with no signal in the stretch writes no offer and no row', async () => {
      const h = build({
        items: { src: [turnComplete(1), userMessage(2, 'thanks, looks good')] },
        config: { quietWindowHours: 1 },
      });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      await settle();

      expect(h.created).toEqual([]);
      expect(h.written).toEqual([]);
    });

    it('a settle with nothing new past the reflected watermark writes nothing', async () => {
      const h = build({
        items: { src: correctionStretch() },
        config: { quietWindowHours: 1 },
      });
      h.runs.get('src')!.reflectedThroughSeq = 2;
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      await vi.advanceTimersByTimeAsync(HOUR_MS);
      await settle();

      expect(h.created).toEqual([]);
    });
  });

  describe('a done close that fires while the run is still working', () => {
    it('waits for the next settle, then the full 10 minutes', async () => {
      const h = build({ items: { src: correctionStretch() } });
      const run = h.runs.get('src')!;
      h.service.onModuleInit();

      h.bus.publishRunStatus({
        runId: 'src',
        status: null,
        outcome: recordedOutcome(),
      });
      run.status = 'running';
      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS);
      await settle();
      expect(h.created).toEqual([]);
      expect(h.service.waiting('src')).toBeNull();

      run.status = 'completed';
      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      expect(h.service.waiting('src')).toBe('done');

      await vi.advanceTimersByTimeAsync(LESSON_DONE_QUIET_MS - 1);
      await settle();
      expect(h.created).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.created).toEqual([
        expect.objectContaining({ runId: 'src', closedBy: 'done' }),
      ]);
    });
  });

  describe('the open segment of a thread', () => {
    it('a second close with nothing new past the open segment writes nothing', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      const first = await h.service.close('src', 'manual');
      expect(first).not.toBeNull();
      const second = await h.service.close('src', 'manual');

      expect(second).toBeNull();
      expect(h.created).toHaveLength(1);
      expect(h.updated).toEqual([]);
      expect(h.written).toHaveLength(1);
    });

    it('a later close with new items extends the open segment and writes a new offer row', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      await h.service.close('src', 'manual');
      h.items.get('src')!.push(userMessage(3, 'no, still wrong'));
      await h.service.close('src', 'idle');

      expect(h.created).toHaveLength(1);
      expect(h.updated).toEqual([
        {
          id: 'seg-1',
          fields: expect.objectContaining({ toSeq: 3, closedBy: 'idle' }),
        },
      ]);
      expect(h.written).toHaveLength(2);
      expect(h.written[1]).toEqual({
        runId: 'src',
        kind: 'lesson_offer',
        payload: expect.objectContaining({
          segmentId: 'seg-1',
          fromSeq: -1,
          toSeq: 3,
        }),
      });
    });
  });

  describe('switches', () => {
    it('the app setting off writes nothing, however the thread is closed', async () => {
      const h = build({
        items: { src: correctionStretch() },
        config: { mode: 'off' },
      });
      h.service.onModuleInit();

      await expect(h.service.close('src', 'manual')).resolves.toBeNull();
      expect(h.created).toEqual([]);
      expect(h.written).toEqual([]);
    });

    it('a project set to off writes nothing', async () => {
      const h = build({
        items: { src: correctionStretch() },
        project: { lessons: 'off' },
      });
      h.service.onModuleInit();

      await expect(h.service.close('src', 'manual')).resolves.toBeNull();
      expect(h.created).toEqual([]);
    });

    it('a team set to on is offered even when its project is off', async () => {
      const h = build({
        items: { src: correctionStretch() },
        runs: [runOf({ teamId: 'team-1' })],
        project: { lessons: 'off' },
        teamLessons: 'on',
      });
      h.service.onModuleInit();

      await expect(h.service.close('src', 'manual')).resolves.toMatchObject({
        runId: 'src',
        closedBy: 'manual',
      });
      expect(h.created).toHaveLength(1);
    });

    it('a team set to off wins over a project set to on', async () => {
      const h = build({
        items: { src: correctionStretch() },
        runs: [runOf({ teamId: 'team-1' })],
        project: { lessons: 'on' },
        teamLessons: 'off',
      });
      h.service.onModuleInit();

      await expect(h.service.close('src', 'manual')).resolves.toBeNull();
      expect(h.created).toEqual([]);
    });
  });

  describe('start-up sweep', () => {
    it('closes threads quiet past the window and re-arms the rest', async () => {
      const start = Date.now();
      const sweepAt = start + LESSON_BOOT_SWEEP_DELAY_MS;
      const quietPast = runOf({
        id: 'quiet',
        updatedAt: new Date(sweepAt - 4 * HOUR_MS),
      });
      const recent = runOf({
        id: 'recent',
        updatedAt: new Date(sweepAt - HOUR_MS),
      });
      const live = runOf({
        id: 'live',
        status: 'running',
        updatedAt: new Date(sweepAt - 4 * HOUR_MS),
      });
      const h = build({
        runs: [quietPast, recent, live],
        items: {
          quiet: correctionStretch(),
          recent: correctionStretch(),
          live: correctionStretch(),
        },
        candidates: [quietPast, recent, live],
      });
      h.service.onModuleInit();
      h.service.onApplicationBootstrap();

      await vi.advanceTimersByTimeAsync(LESSON_BOOT_SWEEP_DELAY_MS);
      await settle();

      expect(h.created).toEqual([
        expect.objectContaining({ runId: 'quiet', closedBy: 'idle' }),
      ]);
      expect(h.service.waiting('live')).toBeNull();
      expect(h.service.waiting('recent')).toBe('idle');

      await vi.advanceTimersByTimeAsync(2 * HOUR_MS - 1);
      await settle();
      expect(h.created).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.created).toEqual([
        expect.objectContaining({ runId: 'quiet' }),
        expect.objectContaining({ runId: 'recent', closedBy: 'idle' }),
      ]);
    });
  });

  describe('teardown', () => {
    it('clears every waiting close when the module is destroyed', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunStatus({ runId: 'src', status: 'completed' });
      h.service.onModuleDestroy();
      expect(h.service.waiting('src')).toBeNull();

      await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
      await settle();
      expect(h.created).toEqual([]);
    });
  });
});
