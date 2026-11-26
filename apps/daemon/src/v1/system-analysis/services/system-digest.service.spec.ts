import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentFlagDao } from '../../agents/dao/agent-flag.dao';
import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { LessonProposalDao } from '../../lessons/dao/lesson-proposal.dao';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { MetricLedgerDao } from '../../stats/dao/metric-ledger.dao';
import { ToolCallEvent } from '../../stats/entity/tool-call-event.entity';
import {
  type SystemAnalysisDb,
  systemAnalysisDb,
} from '../__tests__/system-analysis-db';
import {
  SYSTEM_ANALYSIS_MAX_THREADS,
  SYSTEM_DIGEST_PAYLOAD_CANDIDATES,
} from '../system-analysis.types';
import { SystemDigestService } from './system-digest.service';

const PERIOD = {
  from: new Date('2026-11-01T00:00:00.000Z'),
  to: new Date('2026-11-08T00:00:00.000Z'),
  days: 7,
};
const AT = new Date('2026-11-05T10:00:00.000Z');
const LATER = new Date('2026-11-05T11:00:00.000Z');

function runRow(id: string, extra: Partial<Run> = {}): Run {
  return Object.assign(new Run(), {
    id,
    status: 'completed',
    title: id,
    updatedAt: AT,
    ...extra,
  });
}

function itemRow(runId: string, seq: number, extra: Partial<Item> = {}): Item {
  return Object.assign(new Item(), {
    runId,
    seq,
    kind: 'message',
    role: 'assistant',
    payload: JSON.stringify({ text: 'hi' }),
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  });
}

function failedCallRow(
  runId: string,
  seq: number,
  tool: string,
  mcpServer: string | null,
): ToolCallEvent {
  return Object.assign(new ToolCallEvent(), {
    runId,
    seq,
    occurredAt: AT,
    tool,
    mcpServer,
    ok: false,
  });
}

describe('SystemDigestService.build (in-memory sqlite)', () => {
  let db: SystemAnalysisDb;
  let digests: SystemDigestService;

  beforeEach(async () => {
    db = await systemAnalysisDb();
    const em = db.em.fork();
    digests = new SystemDigestService(
      db.em,
      new RunDao(em),
      new ItemDao(em),
      new GoalDao(em),
      new AgentFlagDao(em),
      new MetricLedgerDao(em),
      new LessonProposalDao(em),
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('ranks the reflection with a dropped lesson and the chat with two work flags, and leaves out a clean thread, a system analysis (its flag not counted) and a deleted thread’s flag from the threads', async () => {
    await db.seedRun('busy-chat', { updatedAt: AT });
    await db.seedItem('busy-chat', 0, AT);
    await db.seedFlag('busy-chat', 'work', AT, { handle: 'F-b1' });
    await db.seedFlag('busy-chat', 'work', AT, { handle: 'F-b2' });

    await db.seedRun('lesson-run', {
      analysisPurpose: 'lessons',
      updatedAt: new Date('2026-11-05T11:00:00.000Z'),
    });
    await db.seedItem('lesson-run', 0, AT);
    await db.seedDroppedLesson('lesson-run', 0);

    await db.seedRun('clean-chat', { updatedAt: AT });
    await db.seedItem('clean-chat', 0, AT);

    await db.seedRun('system-run', {
      analysisPurpose: 'system',
      updatedAt: AT,
    });
    await db.seedItem('system-run', 0, AT);
    await db.seedFlag('system-run', 'work', AT, { handle: 'F-sys' });

    await db.seedFlag('gone-run', 'work', AT, { handle: 'F-gone' });

    const { digest, runs } = await digests.build(PERIOD);

    expect(digest.threads.map((thread) => thread.runId)).toEqual([
      'busy-chat',
      'lesson-run',
    ]);
    expect(digest.threads[1]?.signals.analysisRefusals).toBe(1);
    expect(digest.totals).toEqual({
      threadsWithSignals: 2,
      flags: 3,
      failedToolCalls: 0,
      systemThreads: 1,
    });
    expect(digest.flags.map((flag) => flag.handle)).toEqual(['F-b1', 'F-b2']);
    expect(digest.goneFlags.map((flag) => flag.handle)).toEqual(['F-gone']);
    expect(runs.map((run) => run.runId)).toEqual(['busy-chat', 'lesson-run']);
    expect(runs.map((run) => run.snapshotSeq)).toEqual(
      digest.threads.map((thread) => thread.snapshotSeq),
    );
  });

  it("pins geniro's own threads beside the 30 user threads, though every user thread has more failed calls than the cap", async () => {
    const rows: object[] = [];
    for (let index = 0; index <= SYSTEM_ANALYSIS_MAX_THREADS; index++) {
      const runId = `user-${index}`;
      rows.push(runRow(runId), itemRow(runId, 0));
      for (let call = 0; call < 10; call++) {
        rows.push(failedCallRow(runId, call, 'Bash', null));
      }
    }
    rows.push(
      runRow('lessons-run', { analysisPurpose: 'lessons' }),
      itemRow('lessons-run', 0),
      failedCallRow('lessons-run', 0, 'propose_lessons', 'geniro'),
      failedCallRow('lessons-run', 1, 'propose_lessons', 'geniro'),
      runRow('analysis-run', { analysisSourceRunId: 'user-0' }),
      itemRow('analysis-run', 0),
      failedCallRow('analysis-run', 0, 'report_recommendations', 'geniro'),
      failedCallRow('analysis-run', 1, 'report_recommendations', 'geniro'),
    );
    await db.persistAll(rows);

    const { digest, runs } = await digests.build(PERIOD);

    const kindOf = (runId: string) =>
      digest.threads.find((thread) => thread.runId === runId)?.kind;
    expect(kindOf('lessons-run')).toBe('lessons');
    expect(kindOf('analysis-run')).toBe('thread_analysis');
    expect(
      digest.threads.filter((thread) => thread.runId.startsWith('user-')),
    ).toHaveLength(SYSTEM_ANALYSIS_MAX_THREADS);
    expect(digest.totals.systemThreads).toBe(2);
    expect(runs.map((run) => run.runId)).toEqual(
      expect.arrayContaining(['lessons-run', 'analysis-run']),
    );
  });

  it('reads the transcript of a system thread though 200 user threads rank above it in the ledgers', async () => {
    const rows: object[] = [];
    for (let index = 0; index < SYSTEM_DIGEST_PAYLOAD_CANDIDATES; index++) {
      const runId = `user-${index}`;
      rows.push(
        runRow(runId, { updatedAt: LATER }),
        itemRow(runId, 0),
        failedCallRow(runId, 0, 'Bash', null),
        failedCallRow(runId, 1, 'Bash', null),
      );
    }
    rows.push(
      runRow('lessons-run', { analysisPurpose: 'lessons' }),
      itemRow('lessons-run', 0, { kind: 'turn_complete', payload: '{}' }),
      itemRow('lessons-run', 1, {
        role: 'user',
        payload: JSON.stringify({ text: 'no, that is wrong' }),
      }),
    );
    await db.persistAll(rows);
    await db.seedDroppedLesson('lessons-run', 1);

    const { digest } = await digests.build(PERIOD);

    expect(
      digest.threads.find((thread) => thread.runId === 'lessons-run')?.signals
        .corrections,
    ).toBe(1);
  });

  it('yields the event loop while it reads the transcripts of several candidates', async () => {
    for (const runId of ['r1', 'r2', 'r3']) {
      await db.seedRun(runId, { updatedAt: AT });
      await db.seedItem(runId, 0, AT);
      await db.seedFlag(runId, 'work', AT);
    }
    let turnTaken = false;
    setImmediate(() => {
      turnTaken = true;
    });

    const { digest } = await digests.build(PERIOD);

    expect(digest.threads).toHaveLength(3);
    expect(turnTaken).toBe(true);
  });
});
