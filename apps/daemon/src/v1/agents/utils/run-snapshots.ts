import type { EntityManager } from '@mikro-orm/sqlite';

import { isTerminalRunStatus } from '../../runs/runs.types';
import type { AnalysedRun } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';

/** What reading a run's snapshot needs. */
export interface RunSnapshotReaders {
  em: EntityManager;
  runDao: RunDao;
  itemDao: ItemDao;
}

/**
 * A run's newest seq and whether it was working at it, read so the two
 * belong together: a turn starting or settling between two separate reads
 * would pair a snapshot with the wrong flag, and the flag is kept for good.
 * Re-read until no row landed in between.
 */
export async function runSnapshotOf(
  readers: RunSnapshotReaders,
  runId: string,
): Promise<{ snapshotSeq: number; working: boolean }> {
  const em = readers.em.fork();
  let before = await readers.itemDao.maxSeq(runId, em);
  for (let attempt = 0; ; attempt += 1) {
    // A fresh fork each pass: one that already holds the run would answer
    // from its identity map with the status read before the loop.
    const run = await readers.runDao.getById(runId, readers.em.fork());
    const after = await readers.itemDao.maxSeq(runId, em);
    if (after === before || attempt >= 4) {
      return {
        snapshotSeq: after,
        working: run !== null && !isTerminalRunStatus(run.status),
      };
    }
    before = after;
  }
}

/**
 * A workflow's newest unarchived runs, newest first, each read at its own
 * snapshot, with the folder it ran in. A run with no rows yet is skipped.
 */
export async function workflowRunSnapshots(
  readers: RunSnapshotReaders,
  slug: string,
  limit: number,
): Promise<(AnalysedRun & { cwd: string | null })[]> {
  const candidates = await readers.runDao.newestWorkflowRuns(
    slug,
    limit,
    readers.em.fork(),
  );
  const runs: (AnalysedRun & { cwd: string | null })[] = [];
  for (const candidate of candidates) {
    const { snapshotSeq, working } = await runSnapshotOf(readers, candidate.id);
    if (snapshotSeq >= 0) {
      runs.push({
        runId: candidate.id,
        snapshotSeq,
        working,
        cwd: candidate.cwd,
      });
    }
  }
  return runs;
}
