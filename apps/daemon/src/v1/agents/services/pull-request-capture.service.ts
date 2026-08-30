import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

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
import { AgentEventBus } from './agent-events.bus';

/**
 * The item kinds that END a turn — the moment a pull request the turn opened
 * is worth looking for. Spelled here rather than imported from
 * `ChatTitleService`, which keeps its own for its own reasons; the two
 * answering the same question is a coincidence, not a shared rule.
 */
const TURN_ENDING_KINDS = new Set(['turn_complete', 'turn_cancelled', 'error']);

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
export class PullRequestCaptureService implements OnModuleInit {
  private readonly logger = new Logger(PullRequestCaptureService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly em: EntityManager,
    private readonly bus: AgentEventBus,
  ) {}

  /**
   * Capture on a turn's END as well as on the chat list, and ANNOUNCE what
   * was found.
   *
   * The listing was the only trigger for a release, and that is one fetch per
   * window — so a thread that opened a pull request DURING the session it was
   * opened in never showed a chip for it. REPORTED as exactly that, on a
   * thread whose own transcript links the pull request it made. Reconstructed
   * from the reporter's database: the window listed the chats when that run
   * held 441 items, the `gh pr create` landed at seq 1827, and the marker was
   * still 441 hours later — one `GET /v1/chats` moved it to 2170 and captured
   * `#79` at once. Nothing was broken; nothing had asked.
   *
   * The sidebar stays current between listings on the `run_status` broadcast,
   * which carried no pull requests, so this is the same seam `ChatTitleService`
   * already uses for the same shape of problem — a fact settled a moment after
   * the turn ends, typically once the user has moved on. It is a SUBSCRIBER
   * rather than a call from `ChatService` for the reason the stats recorder is
   * one: the bus is where both execution paths converge, and nothing in the
   * turn path should have to remember to do this.
   *
   * Only a CHAT run (`nodeId === null`) and only a terminal item, which is
   * what keeps this to one pass per turn rather than one per tool call — in
   * the steady state that pass is a single indexed `max(seq)` read.
   */
  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (
        event.item.nodeId !== null ||
        !TURN_ENDING_KINDS.has(event.item.kind)
      ) {
        return;
      }
      void this.captureAndAnnounce(event.runId);
    });
  }

  /**
   * Scan one run and tell every window what it holds now.
   *
   * `status: null`, like the activity and hold announces beside it: this says
   * what the run HAS, never whether it is still going, and a status asserted
   * by an event that never read the run is the defect the nullable status
   * exists to prevent.
   *
   * Silent when there is nothing to say. A chat with no pull requests is the
   * common case and would otherwise broadcast an empty array to every window
   * on every turn of every conversation.
   */
  private async captureAndAnnounce(runId: string): Promise<void> {
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        return;
      }
      const before = run.pullRequests;
      await this.syncOne(run, em);
      if (run.pullRequests === before || run.pullRequests === null) {
        return;
      }
      this.bus.publishRunStatus({
        runId,
        status: null,
        pullRequests: readRunPullRequests(run.pullRequests),
      });
    } catch (error) {
      // Swallowed on this path too, and for the listing's own reason: a
      // subscriber that rejects takes the RxJS stream down with it, which
      // would cost far more than a missing chip.
      this.logger.warn(
        `run ${runId}: could not capture pull requests on settle: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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
