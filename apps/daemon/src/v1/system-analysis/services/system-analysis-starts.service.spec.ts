import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatService } from '../../agents/services/chat.service';
import type { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import type { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import type { FiledRecommendation } from '../../stats/stats.types';
import { SYSTEM_LEDGER_SLUG } from '../../stats/stats.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import {
  type SystemAnalysisDb,
  systemAnalysisDb,
} from '../__tests__/system-analysis-db';
import { SystemAnalysisEventBus } from './system-analysis-events.bus';
import { SystemAnalysisStartsService } from './system-analysis-starts.service';

const ANALYSIS = 'analysis-1';
const THREAD = 'thread-1';
const CARD_SEQ = 2;
const AT = new Date('2026-11-05T10:00:00.000Z');

function filedRow(itemId: string, chatRunId = ANALYSIS): FiledRecommendation {
  return {
    slug: SYSTEM_LEDGER_SLUG,
    chatRunId,
    chatKind: 'system',
    cardSeq: CARD_SEQ,
    filedAt: AT,
    libraryVersion: null,
    itemId,
    target: 'geniro',
    territory: 'process',
    kind: 'ADD',
    location: 'apps/daemon',
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

describe('SystemAnalysisStartsService (in-memory sqlite)', () => {
  let db: SystemAnalysisDb;
  let service: SystemAnalysisStartsService;
  let ledger: TeamRecommendationDao;
  let taskDao: TaskDao;
  let info: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  let recordAnalysisRow: ReturnType<typeof vi.fn>;
  let announced: string[];

  beforeEach(async () => {
    db = await systemAnalysisDb();
    await db.seedRun(ANALYSIS, {
      analysisPurpose: 'system',
      status: 'completed',
    });
    await db.seedRun(THREAD, { status: 'completed' });
    await db.seedProject({ id: 'proj-1', taskKey: 'GEN' });
    await db.seedProject({ id: 'proj-nokey', taskKey: null });
    await db.seedTask({
      id: 'card-1',
      projectId: 'proj-1',
      title: 'Retry the fetch',
      number: 7,
      status: 'in_progress',
      runId: THREAD,
      source: 'system_analysis',
      sourceRef: `${ANALYSIS}:${CARD_SEQ}:G-1`,
      startRequestKind: 'analysis',
      startRequestedByRunId: ANALYSIS,
      startRequestedAt: null,
      startApprovedAt: AT,
    });
    await db.seedTask({
      id: 'card-2',
      projectId: 'proj-nokey',
      title: 'Cap the output',
      number: 3,
      status: 'in_progress',
      runId: THREAD,
      source: 'system_analysis',
      sourceRef: `${ANALYSIS}:${CARD_SEQ}:G-2`,
      startRequestKind: 'analysis',
      startRequestedByRunId: ANALYSIS,
      startRequestedAt: null,
      startApprovedAt: AT,
    });

    const em = db.em.fork();
    taskDao = new TaskDao(em);
    ledger = new TeamRecommendationDao(em);
    await ledger.file([filedRow('G-1'), filedRow('G-2')]);
    await ledger.markApplied(ANALYSIS, CARD_SEQ, 'G-1', {
      taskId: 'card-1',
      applyAction: 'start_requested',
    });
    await ledger.markApplied(ANALYSIS, CARD_SEQ, 'G-2', {
      taskId: 'card-2',
      applyAction: 'start_requested',
    });

    const projects = new Map(
      [
        Object.assign(new Project(), {
          id: 'proj-1',
          name: 'Geniro',
          taskKey: 'GEN',
        }),
        Object.assign(new Project(), {
          id: 'proj-nokey',
          name: 'Nokey',
          taskKey: null,
        }),
      ].map((project) => [project.id, project]),
    );
    info = vi.fn(() => Promise.resolve());
    warn = vi.fn(() => Promise.resolve());
    recordAnalysisRow = vi.fn(() => Promise.resolve({ seq: 0 }));
    const events = new SystemAnalysisEventBus();
    announced = [];
    events.allChanges().subscribe((change) => announced.push(change.runId));

    service = new SystemAnalysisStartsService(
      db.em,
      taskDao,
      new TaskEventBus(),
      { recordAnalysisRow } as unknown as ChatService,
      ledger,
      { info, warn } as unknown as RunNoticeWriter,
      {
        getById: (id: string) => Promise.resolve(projects.get(id) ?? null),
      } as unknown as ProjectDao,
      events,
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('marks the filed item started, tells the analysis once, and writes its outcome row', async () => {
    await service.reportStarted();

    const rows = await ledger.rowsOf(SYSTEM_LEDGER_SLUG, db.em.fork());
    expect(rows.find((row) => row.itemId === 'G-1')?.applyAction).toBe(
      'started',
    );
    expect(
      info.mock.calls.filter(
        ([, message]) => message === 'Started "Retry the fetch"',
      ),
    ).toEqual([[ANALYSIS, 'Started "Retry the fetch"']]);
    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: [
          expect.objectContaining({
            id: 'G-1',
            status: 'applied',
            note: 'started GEN-7',
          }),
        ],
      },
    );
    expect(announced).toEqual([ANALYSIS, ANALYSIS]);
  });

  it('names the card by its task id when its project has no key', async () => {
    await service.reportStarted();

    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: [
          expect.objectContaining({
            id: 'G-2',
            status: 'applied',
            note: 'started card-2',
          }),
        ],
      },
    );
  });

  it('tells the analysis once when two reports of the same start race', async () => {
    await Promise.all([service.reportStarted(), service.reportStarted()]);

    expect(info.mock.calls.map(([, message]) => message).sort()).toEqual([
      'Started "Cap the output"',
      'Started "Retry the fetch"',
    ]);
    expect(recordAnalysisRow).toHaveBeenCalledTimes(2);
    expect(
      (await taskDao.getById('card-1', db.em.fork()))?.startRequestedByRunId,
    ).toBeNull();
  });

  it('names the failed card by its task id when its project has no key', async () => {
    await service.reportFailed({
      taskId: 'card-2',
      byRunId: ANALYSIS,
      title: 'Cap the output',
      reason: 'folder is gone',
    });

    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: [
          {
            id: 'G-2',
            status: 'failed',
            note: 'could not start card-2: folder is gone',
          },
        ],
      },
    );
  });

  it('marks a filed card failed with its key and warns the analysis when its start fails', async () => {
    await service.reportFailed({
      taskId: 'card-1',
      byRunId: ANALYSIS,
      title: 'Retry the fetch',
      reason: 'no agent on the project',
    });

    expect(recordAnalysisRow).toHaveBeenCalledWith(
      ANALYSIS,
      'recommendation_outcome',
      {
        cardSeq: CARD_SEQ,
        outcomes: [
          {
            id: 'G-1',
            status: 'failed',
            note: 'could not start GEN-7: no agent on the project',
          },
        ],
      },
    );
    const rows = await ledger.rowsOf(SYSTEM_LEDGER_SLUG, db.em.fork());
    expect(rows.find((row) => row.itemId === 'G-1')?.applyAction).toBe('filed');
    expect(warn).toHaveBeenCalledWith(
      ANALYSIS,
      'Could not start "Retry the fetch": no agent on the project',
      'Start failed',
    );
    expect(announced).toEqual([ANALYSIS]);
  });

  it('warns the analysis of a failed start even when no ledger item holds the card', async () => {
    await service.reportFailed({
      taskId: 'card-unknown',
      byRunId: ANALYSIS,
      title: 'Orphan',
      reason: 'gone',
    });

    expect(recordAnalysisRow).not.toHaveBeenCalled();
    expect(announced).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      ANALYSIS,
      'Could not start "Orphan": gone',
      'Start failed',
    );
  });
});
