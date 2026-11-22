import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ItemWire,
  RecommendationItem,
  RecommendationsPayload,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { ChatService } from '../../agents/services/chat.service';
import type { RunLiveWork } from '../../agents/services/run-live-work.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Item } from '../../runs/entity/item.entity';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import type { FiledRecommendation } from '../../stats/stats.types';
import { SYSTEM_LEDGER_SLUG } from '../../stats/stats.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { TaskAttachmentService } from '../../tasks/services/task-attachment.service';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { TasksService } from '../../tasks/services/tasks.service';
import {
  type SystemAnalysisDb,
  systemAnalysisDb,
} from '../__tests__/system-analysis-db';
import type { SystemApply } from '../system-analysis.types';
import { SystemAnalysisApplyService } from './system-analysis-apply.service';

const ANALYSIS = 'analysis-1';
const CARD_SEQ = 2;
const PROJECT = 'proj-1';
const ARMED = 'proj-armed';
const BARE = 'proj-bare';
const AT = new Date('2026-11-05T10:00:00.000Z');

function geniroItem(id: string, title: string): RecommendationItem {
  return {
    id,
    target: 'geniro',
    territory: 'process',
    kind: 'ADD',
    location: 'apps/daemon/src/v1/tasks',
    title,
    change: `the change for ${id}`,
    evidence: [{ seq: 4, quote: 'failed again' }],
    rootCause: 'the same failure each run',
    impact: {
      minutesSaved: 12,
      costSavedUsd: null,
      basis: 'failed calls',
      confidence: 4,
      outcome: 'no retries',
    },
    risk: { level: 'low', note: 'none' },
  };
}

function userItem(id: string): RecommendationItem {
  return {
    ...geniroItem(id, 'A rule for the user'),
    target: 'user',
    kind: 'update',
    location: 'AGENTS.md:12',
  };
}

const CARD: RecommendationsPayload = {
  sourceRunId: 'thread-1',
  sourceKind: 'system',
  timing: null,
  items: [
    geniroItem('G-1', 'Retry the fetch once'),
    geniroItem('G-2', 'Cap the output'),
    userItem('U-1'),
  ],
};

function ledgerRow(itemId: string, target: string): FiledRecommendation {
  return {
    slug: SYSTEM_LEDGER_SLUG,
    chatRunId: ANALYSIS,
    chatKind: 'system',
    cardSeq: CARD_SEQ,
    filedAt: AT,
    libraryVersion: null,
    itemId,
    target,
    territory: 'process',
    kind: 'ADD',
    location: 'somewhere',
    title: `item ${itemId}`,
    change: 'change',
    rootCause: 'cause',
    minutesSaved: 12,
    costSavedUsd: null,
    expectedOutcome: null,
    confidence: 4,
    risk: 'low',
  };
}

describe('SystemAnalysisApplyService.apply (in-memory sqlite)', () => {
  let db: SystemAnalysisDb;
  let service: SystemAnalysisApplyService;
  let taskDao: TaskDao;
  let ledger: TeamRecommendationDao;
  let tasks: TasksService;
  let recordApply: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let recordAnalysisRow: ReturnType<typeof vi.fn>;
  let nextSeq: number;

  async function persistApply(
    runId: string,
    payload: Record<string, unknown>,
  ): Promise<ItemWire> {
    const seq = nextSeq;
    nextSeq += 1;
    await db.persistAll([
      Object.assign(new Item(), {
        runId,
        seq,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify(payload),
        createdAt: AT,
        updatedAt: AT,
      }),
    ]);
    return { seq } as ItemWire;
  }

  async function tasksOf(projectId: string) {
    return taskDao.listForProject(projectId, db.em.fork());
  }

  beforeEach(async () => {
    db = await systemAnalysisDb();
    nextSeq = 100;
    await db.seedRun(ANALYSIS, {
      analysisPurpose: 'system',
      status: 'completed',
    });
    await db.persistAll([
      Object.assign(new Item(), {
        runId: ANALYSIS,
        seq: CARD_SEQ,
        kind: 'recommendations',
        role: null,
        payload: JSON.stringify(CARD),
        createdAt: AT,
        updatedAt: AT,
      }),
    ]);
    await db.seedProject({ id: PROJECT, agentKind: 'claude' });
    await db.seedProject({
      id: ARMED,
      name: 'Armed',
      taskKey: 'ARM',
      autopilotEnabled: true,
      autopilotIntakeStatus: 'backlog',
      agentKind: 'claude',
    });
    await db.seedProject({ id: BARE, name: 'Bare', taskKey: 'BARE' });

    const em = db.em.fork();
    const projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    ledger = new TeamRecommendationDao(em);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      {} as TaskAttachmentService,
      new RunDao(em),
      {} as RunLiveWork,
    );
    await ledger.file([
      ledgerRow('G-1', 'geniro'),
      ledgerRow('G-2', 'geniro'),
      ledgerRow('U-1', 'user'),
    ]);

    recordApply = vi.fn((runId: string, text: string, apply: unknown) =>
      persistApply(runId, { text, apply }),
    );
    sendMessage = vi.fn(
      (
        runId: string,
        text: string,
        _images: unknown,
        options: { apply: unknown },
      ) => persistApply(runId, { text, apply: options.apply }),
    );
    recordAnalysisRow = vi.fn(() => Promise.resolve({ seq: 0 } as ItemWire));

    service = new SystemAnalysisApplyService(
      db.em,
      new RunDao(em),
      new ItemDao(em),
      {
        recordApply,
        sendMessage,
        recordAnalysisRow,
      } as unknown as ChatService,
      projectDao,
      taskDao,
      tasks,
      ledger,
    );
  });

  afterEach(async () => {
    await db.close();
  });

  function press(over: Partial<SystemApply> = {}): SystemApply {
    return {
      cardSeq: CARD_SEQ,
      ids: ['G-1', 'G-2'],
      action: 'cards',
      projectId: PROJECT,
      clientMessageId: 'press-1',
      ...over,
    };
  }

  it('files one card per selected geniro item into the picked project, from the system source', async () => {
    const result = await service.apply(ANALYSIS, press());

    const filed = await tasksOf(PROJECT);
    expect(filed.map((task) => [task.title, task.status, task.number])).toEqual(
      expect.arrayContaining([
        ['Retry the fetch once', 'backlog', 1],
        ['Cap the output', 'backlog', 2],
      ]),
    );
    expect(filed.every((task) => task.source === 'system_analysis')).toBe(true);
    expect(filed.map((task) => task.sourceRef).sort()).toEqual([
      `${ANALYSIS}:${CARD_SEQ}:G-1`,
      `${ANALYSIS}:${CARD_SEQ}:G-2`,
    ]);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        id: 'G-1',
        status: 'applied',
        identifier: 'GEN-1',
        reason: 'filed GEN-1',
      }),
      expect.objectContaining({
        id: 'G-2',
        status: 'applied',
        identifier: 'GEN-2',
        reason: 'filed GEN-2',
      }),
    ]);
  });

  it('writes a recommendation_outcome row marking each filed item applied', async () => {
    await service.apply(ANALYSIS, press());

    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: [
          { id: 'G-1', status: 'applied', note: 'filed GEN-1' },
          { id: 'G-2', status: 'applied', note: 'filed GEN-2' },
        ],
      },
    );
  });

  it('writes the Apply row through recordApply, without sending a message, when only geniro items are picked', async () => {
    const result = await service.apply(ANALYSIS, press());

    expect(sendMessage).not.toHaveBeenCalled();
    expect(recordApply).toHaveBeenCalledWith(
      ANALYSIS,
      'Create cards: G-1 → GEN-1, G-2 → GEN-2',
      {
        cardSeq: CARD_SEQ,
        ids: ['G-1', 'G-2'],
        action: 'cards',
        projectId: PROJECT,
        filed: [
          expect.objectContaining({ id: 'G-1', identifier: 'GEN-1' }),
          expect.objectContaining({ id: 'G-2', identifier: 'GEN-2' }),
        ],
      },
    );
    expect(result.apply).not.toBeNull();
  });

  it('marks each filed item filed in the ledger, with the card it made', async () => {
    await service.apply(ANALYSIS, press());

    const rows = await ledger.rowsOf(SYSTEM_LEDGER_SLUG, db.em.fork());
    const filedRows = rows.filter((row) => row.itemId.startsWith('G-'));
    expect(filedRows.map((row) => row.applyAction)).toEqual(['filed', 'filed']);
    expect(filedRows.every((row) => row.taskId !== null)).toBe(true);
    expect(rows.find((row) => row.itemId === 'U-1')?.applyAction).toBeNull();
  });

  it('files the cards in todo when the armed intake of the project is backlog', async () => {
    await service.apply(ANALYSIS, press({ projectId: ARMED }));

    const filed = await tasksOf(ARMED);
    expect(filed.map((task) => task.status)).toEqual(['todo', 'todo']);
  });

  it('refuses a second press of the same card with ALREADY_APPLIED and files nothing new', async () => {
    await service.apply(ANALYSIS, press());
    const before = await tasksOf(PROJECT);

    await expect(service.apply(ANALYSIS, press())).rejects.toMatchObject({
      errorCode: 'ALREADY_APPLIED',
    });

    expect(await tasksOf(PROJECT)).toHaveLength(before.length);
    expect(recordApply).toHaveBeenCalledTimes(1);
  });

  it('reuses the card already filed for an item when a press was cut short, and files only what is missing', async () => {
    await db.seedProject({
      id: 'proj-2',
      name: 'Second',
      taskKey: 'TWO',
      taskCounter: 1,
    });
    await db.seedTask({
      id: 'existing-card',
      projectId: 'proj-2',
      number: 1,
      source: 'system_analysis',
      sourceRef: `${ANALYSIS}:${CARD_SEQ}:G-1`,
    });
    const create = vi.spyOn(tasks, 'create');

    const result = await service.apply(
      ANALYSIS,
      press({ projectId: 'proj-2', ids: ['G-1', 'G-2'] }),
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-2',
        sourceRef: `${ANALYSIS}:${CARD_SEQ}:G-2`,
      }),
    );
    expect(result.outcomes[0]).toMatchObject({
      id: 'G-1',
      status: 'applied',
      taskId: 'existing-card',
    });
    expect(await tasksOf('proj-2')).toHaveLength(2);
  });

  it('starts each filed card as an analysis start, approved by the press, on implement', async () => {
    const result = await service.apply(
      ANALYSIS,
      press({ action: 'implement', ids: ['G-1'] }),
    );

    const [task] = await tasksOf(PROJECT);
    expect(task).toMatchObject({
      startRequestKind: 'analysis',
      startRequestedByRunId: ANALYSIS,
    });
    expect(task?.startRequestedAt).toBeInstanceOf(Date);
    expect(task?.startApprovedAt).toBeInstanceOf(Date);
    expect(result.outcomes).toEqual([
      expect.objectContaining({
        id: 'G-1',
        status: 'applied',
        reason: 'filed to start GEN-1',
      }),
    ]);
    const rows = await ledger.rowsOf(SYSTEM_LEDGER_SLUG, db.em.fork());
    expect(rows.find((row) => row.itemId === 'G-1')?.applyAction).toBe(
      'start_requested',
    );
    expect(recordApply).toHaveBeenCalledWith(
      ANALYSIS,
      'Create cards and start: G-1 → GEN-1',
      expect.objectContaining({ action: 'implement' }),
    );
  });

  it('refuses implement on a project with no default agent or team, and files nothing', async () => {
    await expect(
      service.apply(ANALYSIS, press({ action: 'implement', projectId: BARE })),
    ).rejects.toMatchObject({ errorCode: 'PROJECT_NO_DEFAULT_TARGET' });

    expect(await tasksOf(BARE)).toEqual([]);
    expect(recordApply).not.toHaveBeenCalled();
  });

  it('keeps every item of a report as a report, filing nothing and marking each one kept', async () => {
    const result = await service.apply(
      ANALYSIS,
      press({ action: 'report', ids: ['G-1'], projectId: undefined }),
    );

    expect(await tasksOf(PROJECT)).toEqual([]);
    expect(result.outcomes).toEqual(
      ['G-1', 'G-2', 'U-1'].map((id) => ({
        id,
        status: 'skipped',
        reason: 'Kept as report',
      })),
    );
    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: ['G-1', 'G-2', 'U-1'].map((id) => ({
          id,
          status: 'skipped',
          note: 'Kept as report',
        })),
      },
    );
    expect(recordApply).toHaveBeenCalledWith(
      ANALYSIS,
      'Kept as report',
      expect.objectContaining({ action: 'report', projectId: null, filed: [] }),
    );
    const rows = await ledger.rowsOf(SYSTEM_LEDGER_SLUG, db.em.fork());
    expect(rows.map((row) => row.applyAction)).toEqual([
      'kept',
      'kept',
      'kept',
    ]);
  });

  it('sends the user item to the analysis agent, and files only the geniro items as cards', async () => {
    await service.apply(ANALYSIS, press({ ids: ['G-1', 'U-1'] }));

    expect(recordApply).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      ANALYSIS,
      expect.any(String),
      [],
      expect.objectContaining({
        clientMessageId: 'press-1',
        apply: expect.objectContaining({
          ids: ['G-1', 'U-1'],
          filed: [expect.objectContaining({ id: 'G-1' })],
        }),
      }),
    );
    expect(await tasksOf(PROJECT)).toHaveLength(1);
  });

  it('writes no Apply row when every picked item failed to file, so the same card can be pressed again', async () => {
    const create = vi
      .spyOn(tasks, 'create')
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockRejectedValueOnce(new Error('database is locked'));

    const failed = await service.apply(ANALYSIS, press());

    expect(failed.apply).toBeNull();
    expect(failed.outcomes.map((outcome) => outcome.status)).toEqual([
      'failed',
      'failed',
    ]);
    expect(recordApply).not.toHaveBeenCalled();
    create.mockRestore();

    const again = await service.apply(ANALYSIS, press());

    expect(again.apply).not.toBeNull();
    expect(await tasksOf(PROJECT)).toHaveLength(2);
  });
});
