import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import { TeamRecommendationDao } from '../../stats/dao/team-recommendation.dao';
import type { FiledRecommendation } from '../../stats/stats.types';
import { SYSTEM_LEDGER_SLUG } from '../../stats/stats.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import {
  type SystemAnalysisDb,
  systemAnalysisDb,
} from '../__tests__/system-analysis-db';
import { SystemAnalysisHistoryService } from './system-analysis-history.service';

const T0 = new Date('2026-10-31T09:00:00.000Z');
const T1 = new Date('2026-11-01T09:00:00.000Z');
const T2 = new Date('2026-11-02T09:00:00.000Z');
const T3 = new Date('2026-11-03T09:00:00.000Z');

function row(over: Partial<FiledRecommendation>): FiledRecommendation {
  return {
    slug: SYSTEM_LEDGER_SLUG,
    chatRunId: 'old-analysis',
    chatKind: 'system',
    cardSeq: 1,
    filedAt: T1,
    libraryVersion: null,
    itemId: 'G-1',
    target: 'geniro',
    territory: 'process',
    kind: 'ADD',
    location: 'apps/daemon',
    title: 'A change',
    change: 'the change',
    rootCause: 'the cause',
    minutesSaved: 5,
    costSavedUsd: null,
    expectedOutcome: null,
    confidence: 4,
    risk: 'low',
    ...over,
  };
}

describe('SystemAnalysisHistoryService.read (in-memory sqlite)', () => {
  let db: SystemAnalysisDb;
  let service: SystemAnalysisHistoryService;
  let ledger: TeamRecommendationDao;

  beforeEach(async () => {
    db = await systemAnalysisDb();
    await db.seedRun('old-analysis', { analysisPurpose: 'system' });
    await db.seedRun('pending-analysis', { analysisPurpose: 'system' });
    await db.seedRun('reader-run', { analysisPurpose: 'system' });
    await db.seedTask({
      id: 'card-live',
      projectId: 'proj-1',
      title: 'Retry the fetch',
      number: 3,
      status: 'in_review',
      source: 'system_analysis',
      sourceRef: 'old-analysis:1:G-1',
    });

    const em = db.em.fork();
    ledger = new TeamRecommendationDao(em);
    await ledger.file([
      row({ itemId: 'G-1', filedAt: T1 }),
      row({ itemId: 'G-2', filedAt: T0 }),
      row({ chatRunId: 'pending-analysis', itemId: 'P-1', filedAt: T2 }),
      row({ chatRunId: 'gone-analysis', itemId: 'X-1', filedAt: T3 }),
      row({ chatRunId: 'reader-run', itemId: 'R-1', filedAt: T3 }),
      row({
        slug: 'team-a',
        chatKind: 'builder',
        itemId: 'T-1',
        target: 'team',
        filedAt: T3,
      }),
    ]);
    await ledger.markApplied('old-analysis', 1, 'G-1', {
      taskId: 'card-live',
      applyAction: 'started',
    });
    await ledger.markOutcome(
      'old-analysis',
      1,
      { itemId: 'G-1', outcome: 'applied', note: 'started GEN-3' },
      { seq: 5, at: T1 },
    );
    await ledger.markApplied('old-analysis', 1, 'G-2', {
      taskId: 'card-gone',
      applyAction: 'filed',
    });

    service = new SystemAnalysisHistoryService(
      db.em,
      ledger,
      new RunDao(em),
      new TaskDao(em),
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('lists the earlier system items newest first, with status, apply action and the live column of their card', async () => {
    const history = await service.read('reader-run');

    expect(history.analyses).toBe(3);
    expect(
      history.items.map((item) => [
        item.chatRunId,
        item.id,
        item.status,
        item.note,
        item.applyAction,
        item.card,
      ]),
    ).toEqual([
      ['gone-analysis', 'X-1', 'unanswered', null, null, null],
      ['pending-analysis', 'P-1', 'open', null, null, null],
      [
        'old-analysis',
        'G-1',
        'applied',
        'started GEN-3',
        'started',
        { taskId: 'card-live', column: 'in_review', deleted: false },
      ],
      [
        'old-analysis',
        'G-2',
        'not-selected',
        null,
        'filed',
        { taskId: 'card-gone', column: null, deleted: true },
      ],
    ]);
  });

  it("leaves out the reader's own analysis and the rows of the other ledgers", async () => {
    const history = await service.read('reader-run');

    const ids = history.items.map((item) => item.id);
    expect(ids).not.toContain('R-1');
    expect(ids).not.toContain('T-1');
    expect(history.items.map((item) => item.chatRunId)).not.toContain(
      'reader-run',
    );
  });
});
