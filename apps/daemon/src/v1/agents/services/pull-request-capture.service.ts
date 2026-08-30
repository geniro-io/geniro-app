import type { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type { RunPullRequest } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { asRecord, asString } from '../utils/json-util';
import {
  isPullRequestCreateCall,
  mergePullRequests,
  readPullRequestUrls,
  readRunPullRequests,
} from '../utils/pull-request-capture';

/**
 * One `Item.payload` as an object, or null.
 *
 * The column is JSON TEXT — only the wire projection parses it — so every
 * reader of a raw row does this for itself; {@link ItemDao.findToolCallPair}
 * carries the same two lines for the same reason.
 */
function parseRow(payload: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * Which pull requests a run OPENED, read out of the transcript it already
 * wrote and kept on the run row.
 *
 * The WHY is in `utils/pull-request-capture.ts`; this is the pass that runs it.
 * Two properties shape everything here:
 *
 * - It is **incremental**. `Run.pullRequestsScannedSeq` is how far the last
 *   pass looked, so a settled conversation costs one indexed `max(seq)` read
 *   and nothing else, however long it is. A run that has never been scanned
 *   starts at -1, which is what makes the BACKFILL free rather than a migration
 *   — every pull request opened before this feature existed is recovered the
 *   first time its chat is listed.
 * - It **never fails a caller**. This runs inside the chat list, and a chat
 *   list that 500s because a transcript could not be scanned is a far worse
 *   outcome than a thread missing its pull-request row. Every error is logged
 *   and swallowed per run, so one bad transcript costs only its own.
 */
@Injectable()
export class PullRequestCaptureService {
  private readonly logger = new Logger(PullRequestCaptureService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
  ) {}

  /**
   * Bring every run's captured pull requests up to date with its transcript.
   *
   * SEQUENTIAL, like the reads in `usePullRequests` on the other side and for a
   * similar reason: this runs on the chat list, where the runs are the user's
   * whole history, and firing one query per run concurrently would hand SQLite
   * a burst on every refetch to answer a question that is almost always "no
   * change".
   *
   * Mutates the passed rows as well as the database, so the projection that
   * follows in the same request sees what was just captured rather than the
   * previous pass's answer.
   */
  async sync(runs: readonly Run[], em: EntityManager): Promise<void> {
    for (const run of runs) {
      try {
        await this.syncOne(run, em);
      } catch (error) {
        this.logger.warn(
          `run ${run.id}: could not capture pull requests: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async syncOne(run: Run, em: EntityManager): Promise<void> {
    const scanned = run.pullRequestsScannedSeq ?? -1;
    const maxSeq = await this.itemDao.maxSeq(run.id, em);
    if (maxSeq <= scanned) {
      return;
    }
    const rows = await this.itemDao.pullRequestCandidates(run.id, scanned, em);
    const captured: RunPullRequest[] = [];
    for (const row of rows) {
      captured.push(...(await this.capturedFrom(run.id, row, em)));
    }
    const merged = mergePullRequests(
      readRunPullRequests(run.pullRequests),
      captured,
    );
    // The MARKER moves even when nothing was captured — that is the whole point
    // of it. A conversation with no pull requests in it would otherwise be
    // re-scanned from the beginning on every chat list for the rest of its life.
    const pullRequests = merged.length > 0 ? JSON.stringify(merged) : null;
    await this.runDao.updateById(
      run.id,
      { pullRequests, pullRequestsScannedSeq: maxSeq },
      em,
    );
    run.pullRequests = pullRequests;
    run.pullRequestsScannedSeq = maxSeq;
  }

  /**
   * The pull requests one tool result opened, or none.
   *
   * The URL alone is not evidence: `gh pr view`, a `git push` hint and an agent
   * quoting a link all put one in a tool result, and filing those under this
   * thread is the same false claim the branch query made. So the paired tool
   * CALL is fetched and its command has to say `gh pr create` — the one shape
   * that means this conversation opened it.
   *
   * The pair lookup only happens for a row that already carries a URL, which is
   * a handful of rows in the longest transcript here (31 in 14,068).
   */
  private async capturedFrom(
    runId: string,
    row: { seq: number; payload: string },
    em: EntityManager,
  ): Promise<RunPullRequest[]> {
    const payload = parseRow(row.payload);
    const callId = asString(payload?.id);
    const text = asString(payload?.result);
    if (callId === null || text === null) {
      return [];
    }
    const urls = readPullRequestUrls(text);
    if (urls.length === 0) {
      return [];
    }
    const { call } = await this.itemDao.findToolCallPair(runId, callId, em);
    if (call === null) {
      return [];
    }
    if (!isPullRequestCreateCall(parseRow(call.payload)?.input)) {
      return [];
    }
    return urls.map((url) => ({ ...url, seq: row.seq }));
  }
}
