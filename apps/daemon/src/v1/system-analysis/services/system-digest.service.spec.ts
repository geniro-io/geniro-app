import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentFlagDao } from '../../agents/dao/agent-flag.dao';
import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { LessonProposalDao } from '../../lessons/dao/lesson-proposal.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { MetricLedgerDao } from '../../stats/dao/metric-ledger.dao';
import { UsageCounterDao } from '../../stats/dao/usage-counter.dao';
import { ToolUsageService } from '../../stats/services/tool-usage.service';
import { UsageCounterService } from '../../stats/services/usage-counter.service';
import { UsageCounterBackfillService } from '../../stats/services/usage-counter-backfill.service';
import { UsageRegistryService } from '../../stats/services/usage-registry.service';
import { emptyDelta } from '../../stats/utils/usage-counter-delta';
import {
  type SystemAnalysisDb,
  systemAnalysisDb,
} from '../__tests__/system-analysis-db';
import { SystemDigestService } from './system-digest.service';

const PERIOD = {
  from: new Date('2026-11-01T00:00:00.000Z'),
  to: new Date('2026-11-08T00:00:00.000Z'),
  days: 7,
};
const AT = new Date('2026-11-05T10:00:00.000Z');

describe('SystemDigestService.build (in-memory sqlite)', () => {
  let db: SystemAnalysisDb;
  let digests: SystemDigestService;
  let counterDao: UsageCounterDao;
  let registry: UsageRegistryService;

  beforeEach(async () => {
    db = await systemAnalysisDb();
    const em = db.em.fork();
    counterDao = new UsageCounterDao(db.em);
    registry = new UsageRegistryService(counterDao);
    digests = new SystemDigestService(
      db.em,
      new RunDao(em),
      new ItemDao(em),
      new GoalDao(em),
      new AgentFlagDao(em),
      new MetricLedgerDao(em),
      new LessonProposalDao(em),
      new ToolUsageService(
        db.em,
        counterDao,
        new UsageCounterService(counterDao),
        registry,
        new UsageCounterBackfillService(db.em, counterDao, new RunDao(em)),
        new ProjectDao(db.em),
      ),
    );
  });

  it('freezes the usage counters into the digest, with the most called first and every never-called subject, and their line in the totals', async () => {
    await registry.registerGeniroTools(['note_thread', 'memory_read']);
    await counterDao.add([
      {
        subjectKind: 'tool',
        subject: 'memory_read',
        source: 'geniro',
        agentKind: 'claude',
        origin: 'direct',
        projectId: '',
        ...emptyDelta(),
        calls: 7,
        errors: 2,
        refused: 1,
      },
      {
        subjectKind: 'tool',
        subject: 'Bash',
        source: '',
        agentKind: 'claude',
        origin: 'subagent',
        projectId: '',
        ...emptyDelta(),
        calls: 3,
      },
    ]);

    const { digest } = await digests.build(PERIOD);

    expect(digest.toolUsage).toMatchObject({
      asOf: PERIOD.to.toISOString(),
      subjects: 2,
      calls: 10,
      leftOut: 0,
    });
    expect(
      digest.toolUsage?.rows.map((row) => [row.name, row.calls, row.subagent]),
    ).toEqual([
      ['memory_read', 7, 0],
      ['Bash', 3, 3],
    ]);
    expect(digest.toolUsage?.neverCalled.map((row) => row.name)).toContain(
      'note_thread',
    );
    expect(digest.totals.toolUsage).toEqual({
      subjects: 2,
      calls: 10,
      neverCalled: digest.toolUsage?.neverCalled.length,
    });
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
      failedToolCallsByKind: { geniro: 0, otherMcp: 0, shell: 0 },
      geniroToolErrorGroups: 0,
      systemThreads: 1,
      toolUsage: { subjects: 0, calls: 0, neverCalled: 0 },
    });
    expect(digest.flags.map((flag) => flag.handle)).toEqual(['F-b1', 'F-b2']);
    expect(digest.goneFlags.map((flag) => flag.handle)).toEqual(['F-gone']);
    expect(runs.map((run) => run.runId)).toEqual(['busy-chat', 'lesson-run']);
    expect(runs.map((run) => run.snapshotSeq)).toEqual(
      digest.threads.map((thread) => thread.snapshotSeq),
    );
  });

  it("reads the error text of geniro's own failed calls off their result rows and only counts the rest", async () => {
    await db.seedRun('tools-chat', { updatedAt: AT });
    await db.seedItem('tools-chat', 0, AT);
    for (const [seq, code] of [
      [11, 1],
      [12, 137],
    ] as const) {
      await db.seedItem('tools-chat', seq, AT, {
        kind: 'tool_result',
        role: 'tool',
        payload: JSON.stringify({
          result: `INVALID_ARGS: already ended: exit code ${code}`,
          isError: true,
        }),
      });
      await db.seedToolCall('tools-chat', AT, 'stop_monitor', 'geniro', seq);
    }
    await db.seedItem('tools-chat', 13, AT, {
      kind: 'tool_result',
      role: 'tool',
      payload: JSON.stringify({ result: 'Exit code 2', isError: true }),
    });
    await db.seedToolCall('tools-chat', AT, 'Bash', null, 13);
    await db.seedToolCall('tools-chat', AT, 'search', 'docs', 14);

    await db.seedRun('shell-chat', { updatedAt: AT });
    await db.seedItem('shell-chat', 0, AT);
    await db.seedToolCall('shell-chat', AT, 'Bash', null, 1);
    await db.seedToolCall('shell-chat', AT, 'Read', null, 2);

    const { digest } = await digests.build(PERIOD);

    expect(digest.threads.map((thread) => thread.runId)).toEqual([
      'tools-chat',
    ]);
    expect(digest.threads[0]?.signals.failedToolCallsByKind).toEqual({
      geniro: 2,
      otherMcp: 1,
      shell: 1,
    });
    expect(digest.threads[0]?.score).toBe(3);
    expect(digest.totals.failedToolCallsByKind).toEqual({
      geniro: 2,
      otherMcp: 1,
      shell: 3,
    });
    expect(digest.geniroToolErrors).toEqual([
      {
        tool: 'stop_monitor',
        signature: 'INVALID_ARGS: already ended: exit code #',
        count: 2,
        threads: 1,
        readable: true,
        example: { runId: 'tools-chat', seq: 11 },
        error: 'INVALID_ARGS: already ended: exit code 1',
      },
    ]);
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
