import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { GoalDao } from '../../agents/dao/goal.dao';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ArchiveLessonsRegistry } from '../../agents/services/archive-lessons.registry';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { DEFAULT_LESSONS_CONFIG, type LessonsConfig } from '../lessons.types';
import type { LessonSignalGoal } from '../utils/lesson-signals.fold';
import type { LessonEstimateService } from './lesson-estimate.service';
import { LessonSegmentService } from './lesson-segment.service';
import type { LessonSpendService } from './lesson-spend.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
  createdAt?: Date;
};

const minute = (n: number) => new Date(Date.UTC(2026, 10, 1, 12, n));

type StoredSegment = Record<string, unknown> & {
  id: string;
  runId: string;
  status: string;
};

function userMessage(seq: number, text: string): Item {
  return {
    seq,
    kind: 'message',
    role: 'user',
    payload: JSON.stringify({ text }),
    createdAt: minute(seq),
  };
}

function turnComplete(seq: number): Item {
  return {
    seq,
    kind: 'turn_complete',
    role: null,
    payload: '{}',
    createdAt: minute(seq),
  };
}

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
    model: null,
    effort: null,
    contextWindow: null,
    modelParameters: null,
    teamId: null,
    teamSnapshot: null,
    projectId: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    archivedAt: null,
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Run;
}

function queuedSegment(overrides: Partial<StoredSegment> = {}): StoredSegment {
  return {
    id: 'seg-1',
    runId: 'src',
    fromSeq: -1,
    toSeq: 2,
    closedBy: 'archive',
    closedAt: new Date('2026-11-14T10:00:00.000Z'),
    signals: JSON.stringify([
      { kind: 'user_correction', seq: 2, excerpt: 'no' },
    ]),
    status: 'queued',
    skipReason: null,
    leaseUntil: null,
    reflectionRunId: null,
    checkRunId: null,
    failReason: null,
    estimateTokens: 9_000,
    estimateUsd: 0.02,
    attempts: 0,
    ...overrides,
  };
}

function build(
  options: {
    runs?: Run[];
    items?: Record<string, Item[]>;
    segments?: StoredSegment[];
    reflections?: Run[];
    config?: Partial<LessonsConfig>;
    project?: { lessons: 'on' | 'off' | null } | null;
    teamLessons?: 'on' | 'off' | null;
    teamsFail?: boolean;
    goals?: Record<string, LessonSignalGoal[]>;
  } = {},
) {
  const runs = new Map((options.runs ?? [runOf()]).map((run) => [run.id, run]));
  const items = new Map(Object.entries(options.items ?? {}));
  const itemsOf = (runId: string): Item[] => items.get(runId) ?? [];
  const tx = { tag: 'tx' };
  const em = {
    fork: () => em,
    transactional: vi.fn((work: (inner: typeof tx) => Promise<void>) =>
      work(tx),
    ),
  };

  const runDao = {
    getById: vi.fn((runId: string) => Promise.resolve(runs.get(runId) ?? null)),
    updateById: vi.fn(() => Promise.resolve()),
    listLessonReflectionsOf: vi.fn(() =>
      Promise.resolve(options.reflections ?? []),
    ),
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
  const goalDao = {
    listByRun: vi.fn((runId: string) =>
      Promise.resolve(options.goals?.[runId] ?? []),
    ),
  };

  const stored = new Map<string, StoredSegment>(
    (options.segments ?? []).map((segment) => [segment.id, { ...segment }]),
  );
  const created: Record<string, unknown>[] = [];
  const updated: { id: string; fields: Record<string, unknown> }[] = [];
  const segments = {
    getById: vi.fn((id: string) => Promise.resolve(stored.get(id) ?? null)),
    queuedOf: vi.fn((runId: string) =>
      Promise.resolve(
        [...stored.values()].find(
          (segment) => segment.runId === runId && segment.status === 'queued',
        ) ?? null,
      ),
    ),
    create: vi.fn((input: Record<string, unknown>) => {
      const segment = {
        id: `seg-${created.length + 1}`,
        ...input,
      } as StoredSegment;
      created.push(input);
      stored.set(segment.id, segment);
      return Promise.resolve(segment);
    }),
    updateById: vi.fn((id: string, fields: Record<string, unknown>) => {
      updated.push({ id, fields });
      Object.assign(stored.get(id)!, fields);
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
  const typical = {
    runs: 7,
    usd: 0.28,
    durationMs: 34_000,
    model: 'claude-haiku-5-5',
    sameModel: true,
  };
  const spending = {
    typical: vi.fn(() => Promise.resolve(typical)),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const teams = {
    get: vi.fn(() =>
      options.teamsFail === true
        ? Promise.reject(new Error('team is gone'))
        : Promise.resolve({ team: { lessons: options.teamLessons ?? null } }),
    ),
  };

  const config = new LessonsConfigService();
  config.set({ ...DEFAULT_LESSONS_CONFIG, ...options.config });

  const bus = new AgentEventBus();
  const archiveChoices = new ArchiveLessonsRegistry();
  const events = new LessonsEventBus();
  const publishChanged = vi.spyOn(events, 'publishChanged');
  const service = new LessonSegmentService(
    em as unknown as EntityManager,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    goalDao as unknown as GoalDao,
    bus,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    estimates as unknown as LessonEstimateService,
    config,
    events,
    spending as unknown as LessonSpendService,
    teams as unknown as TeamStoreService,
    archiveChoices,
  );
  return {
    service,
    bus,
    archiveChoices,
    tx,
    items,
    created,
    updated,
    runDao,
    segments,
    spending,
    publishChanged,
  };
}

/** Lets the subscription's queued close finish: every fake resolves at once. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('LessonSegmentService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('archive', () => {
    it('queues an archived thread’s stretch at once and publishes the change', async () => {
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
          status: 'queued',
          fromSeq: -1,
          toSeq: 2,
          attempts: 0,
          reflectionRunId: null,
          checkRunId: null,
          estimateTokens: 9_000,
          estimateUsd: 0.02,
        }),
      ]);
      expect(JSON.parse(h.created[0]!.signals as string) as unknown).toEqual([
        expect.objectContaining({ kind: 'user_correction', seq: 2 }),
      ]);
      expect(h.publishChanged).toHaveBeenCalledWith('src');
    });

    it('queues a claude thread whose failed tool call was fixed later, found through its call rows', async () => {
      const h = build({
        items: {
          src: [
            {
              seq: 1,
              kind: 'tool_call',
              role: 'assistant',
              payload: JSON.stringify({ id: 't1', name: 'Bash', input: {} }),
            },
            {
              seq: 2,
              kind: 'tool_result',
              role: 'tool',
              payload: JSON.stringify({
                id: 't1',
                name: null,
                isError: true,
                result: 'boom',
              }),
            },
            {
              seq: 3,
              kind: 'tool_call',
              role: 'assistant',
              payload: JSON.stringify({ id: 't2', name: 'Bash', input: {} }),
            },
            {
              seq: 4,
              kind: 'tool_result',
              role: 'tool',
              payload: JSON.stringify({
                id: 't2',
                name: null,
                isError: false,
                result: 'ok',
              }),
            },
          ],
        },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).not.toBeNull();
      expect(JSON.parse(h.created[0]!.signals as string) as unknown).toEqual([
        expect.objectContaining({ kind: 'error_then_success', seq: 2 }),
      ]);
    });

    it('queues a stretch whose only signal is a goal of the run closed not achieved', async () => {
      const h = build({
        items: { src: [turnComplete(1), userMessage(2, 'thanks, looks good')] },
        goals: {
          src: [
            {
              number: 1,
              text: 'the export saves a csv',
              status: 'not_achieved',
              evidence: 'the button still does nothing',
              closedAt: minute(1),
            },
          ],
        },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).not.toBeNull();
      expect(JSON.parse(h.created[0]!.signals as string) as unknown).toEqual([
        {
          kind: 'goal_unmet',
          seq: 1,
          excerpt:
            'not_achieved g1: the export saves a csv — the button still does nothing',
        },
      ]);
    });

    it('queues nothing for an archived thread with no learning signal in it', async () => {
      const h = build({
        items: { src: [turnComplete(1), userMessage(2, 'thanks, looks good')] },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
      expect(h.publishChanged).not.toHaveBeenCalled();
    });

    it('queues nothing for a thread that finished or went idle without being archived', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.service.onModuleInit();

      h.bus.publishRunsChanged([
        {
          id: 'src',
          status: 'completed',
          archivedAt: null,
        } as unknown as RunWire,
      ]);
      await settle();

      expect(h.created).toEqual([]);
      expect(h.publishChanged).not.toHaveBeenCalled();
    });

    it('extends the queued stretch when a later archive closes more of the thread', async () => {
      const h = build({ items: { src: correctionStretch() } });
      const first = await h.service.close('src', 'archive');
      expect(first).toMatchObject({ id: 'seg-1', toSeq: 2 });

      h.items.set('src', [
        ...correctionStretch(),
        turnComplete(3),
        userMessage(4, 'no, still wrong'),
      ]);
      const second = await h.service.close('src', 'archive');

      expect(h.created).toHaveLength(1);
      expect(h.updated).toEqual([
        {
          id: 'seg-1',
          fields: expect.objectContaining({
            fromSeq: -1,
            toSeq: 4,
            closedBy: 'archive',
            status: 'queued',
          }),
        },
      ]);
      expect(second).toMatchObject({ id: 'seg-1', toSeq: 4 });
    });

    it('queues nothing while a reflection on the thread is still running', async () => {
      const h = build({
        items: { src: correctionStretch() },
        reflections: [
          runOf({ id: 'refl', status: 'running', analysisSourceRunId: 'src' }),
        ],
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });

    it.each([
      ['a project chat', { editsProjectId: 'proj-1' }],
      ['a team builder chat', { editsTeamSlug: 'reviewers' }],
      ['a team analysis', { analysisTeamSlug: 'reviewers' }],
    ])('never queues %s', async (_, overrides) => {
      const h = build({
        runs: [runOf(overrides as Partial<Run>)],
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });
  });

  describe('lessons on or off', () => {
    it('queues nothing when the app’s lessons are off', async () => {
      const h = build({
        config: { mode: 'off' },
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });

    it('queues nothing when the project’s lessons are off, even with the app on', async () => {
      const h = build({
        project: { lessons: 'off' },
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });

    it('queues nothing when the team’s lessons are off, even when the project is on', async () => {
      const h = build({
        runs: [runOf({ teamId: 'team-1' })],
        project: { lessons: 'on' },
        teamLessons: 'off',
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });

    it('queues a stretch when the team turns lessons on over a project that has them off', async () => {
      const h = build({
        runs: [runOf({ teamId: 'team-1' })],
        project: { lessons: 'off' },
        teamLessons: 'on',
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toMatchObject({ id: 'seg-1', toSeq: 2 });
    });

    it('reads the team’s setting from the run’s own snapshot when the team cannot be read', async () => {
      const h = build({
        runs: [runOf({ teamId: 'team-1', teamSnapshot: '{"lessons":"off"}' })],
        teamsFail: true,
        items: { src: correctionStretch() },
      });

      const queued = await h.service.close('src', 'archive');

      expect(queued).toBeNull();
      expect(h.created).toEqual([]);
    });
  });

  describe('the archive dialog’s choice', () => {
    it('queues the stretch when the dialog asked for lessons, though the app’s are off', async () => {
      const h = build({
        config: { mode: 'off' },
        items: { src: correctionStretch() },
      });
      h.archiveChoices.expect('src', 'reflect');

      const queued = await h.service.close('src', 'archive');

      expect(queued).toMatchObject({ status: 'queued', toSeq: 2 });
      expect(h.runDao.updateById).not.toHaveBeenCalled();
    });

    it('records a skipped stretch and moves the watermark past it when the dialog said no', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.archiveChoices.expect('src', 'skip');

      const closed = await h.service.close('src', 'archive');

      expect(closed).toMatchObject({
        status: 'skipped',
        skipReason: 'user_skipped',
        toSeq: 2,
      });
      expect(h.runDao.updateById).toHaveBeenCalledWith(
        'src',
        { reflectedThroughSeq: 2 },
        h.tx,
      );
      expect(h.publishChanged).toHaveBeenCalledWith('src');
    });

    it('turns the stretch already queued for the same range into a skipped one', async () => {
      const h = build({
        segments: [queuedSegment()],
        items: { src: correctionStretch() },
      });
      h.archiveChoices.expect('src', 'skip');

      await h.service.close('src', 'archive');

      expect(h.created).toEqual([]);
      expect(h.updated).toEqual([
        {
          id: 'seg-1',
          fields: expect.objectContaining({
            status: 'skipped',
            skipReason: 'user_skipped',
          }),
        },
      ]);
    });

    it('leaves the watermark alone when a skipped thread holds no learning signal', async () => {
      const h = build({
        items: { src: [turnComplete(1), userMessage(2, 'thanks')] },
      });
      h.archiveChoices.expect('src', 'skip');

      expect(await h.service.close('src', 'archive')).toBeNull();
      expect(h.runDao.updateById).not.toHaveBeenCalled();
    });

    it('spends a choice on one archive: the next close goes by the settings again', async () => {
      const h = build({
        config: { mode: 'off' },
        items: { src: correctionStretch() },
      });
      h.archiveChoices.expect('src', 'reflect');
      await h.service.close('src', 'archive');
      h.items.set('src', [
        ...correctionStretch(),
        turnComplete(3),
        userMessage(4, 'no, still wrong'),
      ]);

      expect(await h.service.close('src', 'archive')).toBeNull();
    });

    it('takes no archive choice for a stretch another closer ends', async () => {
      const h = build({ items: { src: correctionStretch() } });
      h.archiveChoices.expect('src', 'skip');

      await h.service.close('src', 'manual');

      expect(h.archiveChoices.take('src')).toBe('skip');
    });
  });

  describe('threadEstimate', () => {
    it.each([
      ['on', {}, true],
      ['off', { mode: 'off' as const }, false],
    ])(
      'tells the archive dialog whether lessons are %s for the thread',
      async (_, config, lessonsOn) => {
        const h = build({ config, items: { src: correctionStretch() } });

        expect(await h.service.threadEstimate({ runId: 'src' })).toMatchObject({
          signals: 1,
          lessonsOn,
          fromSeq: -1,
          toSeq: 2,
        });
      },
    );

    it('offers what finished runs on the model the reflection would use typically cost', async () => {
      const h = build({ items: { src: correctionStretch() } });

      const answer = await h.service.threadEstimate({ runId: 'src' });

      expect(h.spending.typical).toHaveBeenCalledWith(
        'claude-haiku-5-5',
        expect.anything(),
      );
      expect(answer.typical).toEqual({
        runs: 7,
        usd: 0.28,
        durationMs: 34_000,
        model: 'claude-haiku-5-5',
        sameModel: true,
      });
    });
  });
});
