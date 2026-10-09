import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { Run } from '../../runs/entity/run.entity';
import type { CapturedPullRequest, RunPullRequest } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { asRecord, asString } from '../utils/json-util';
import {
  isPullRequestCreateCall,
  mergePullRequests,
  pullRequestKey,
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
/**
 * The text a tool result printed, whatever shape the CLI gave it.
 *
 * claude's is a string. cursor's ACP `execute` answers with an object —
 * `{exitCode, stdout, stderr}` — so reading only a string captured no pull
 * request cursor ever opened: the URL was in `stdout`, one level down.
 */
function resultText(result: unknown): string | null {
  const text = asString(result);
  if (text !== null) {
    return text;
  }
  return asString(asRecord(result)?.stdout);
}

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
   * A terminal item of ANY run, which is what keeps this to one pass per turn
   * rather than one per tool call — in the steady state that pass is a single
   * indexed `max(seq)` read.
   *
   * It used to require `nodeId === null` as well, and that was a WORKFLOW run
   * excluded outright: every row of one carries a node id, so this subscriber
   * never fired for a single one of them — and the other trigger, the chat
   * listing, reads `RunDao.listChats`, which filters `workflowId: null`. Two
   * independent gates, so a workflow's pull requests were never captured on
   * any path. REPORTED as a shelf showing no chip over a transcript reading
   * "Draft PR #5303 is open"; measured on that run, `pullRequests` and
   * `pullRequestsScannedSeq` were both still null with the `gh pr create` at
   * seq 1347. Nothing about the capture itself is per-node — it reads the run's
   * whole transcript by seq — so a workflow needed no new machinery, only to
   * stop being filtered out. One pass per NODE turn now, which is the same
   * bound seen from the other side: a fan-out's nodes settle a handful of times
   * between them, and each pass is that one `max(seq)` read.
   */
  onModuleInit(): void {
    this.bus.all().subscribe((event) => {
      if (!TURN_ENDING_KINDS.has(event.item.kind)) {
        return;
      }
      void this.captureAndAnnounce(event.runId);
    });
  }

  /** Scan one run on a turn's end — {@link syncOne} announces what it finds. */
  private async captureAndAnnounce(runId: string): Promise<void> {
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (run === null) {
        return;
      }
      await this.syncOne(run, em);
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
    const carried = readRunPullRequests(run.pullRequests);
    const merged = mergePullRequests(carried, captured);
    // The MARKER moves even when nothing was captured — that is the whole point
    // of it. A conversation with no pull requests in it would otherwise be
    // re-scanned from the beginning on every chat list for the rest of its life.
    const pullRequests = merged.length > 0 ? JSON.stringify(merged) : null;
    const before = run.pullRequests;
    // Bookkeeping, not activity: this pass runs over every run a chat list
    // returns, so stamping `updatedAt` here re-dated a whole archive to the
    // moment it was opened (see `RunDao.updateWithoutActivity`).
    await this.runDao.updateWithoutActivity(
      run.id,
      { pullRequests, pullRequestsScannedSeq: maxSeq },
      em,
    );
    run.pullRequests = pullRequests;
    run.pullRequestsScannedSeq = maxSeq;
    if (pullRequests !== null && pullRequests !== before) {
      this.announce(run.id, merged);
    }
    await this.announceOpened(run.id, carried, merged, em);
  }

  /**
   * Tell every window what this run holds now — from WHICHEVER pass found it.
   *
   * It used to be the turn-end pass alone, and that made the answer depend on
   * which pass got there first. Both read the same marker, so a listing that
   * ran between the `gh pr create` and the turn's end captured the pull
   * request SILENTLY, and the turn-end pass then found nothing new and said
   * nothing either. The listing's own reply could not stand in for the
   * announce: this write moves no `updatedAt`, so a window whose copy of the
   * row a live announce had dated later kept that copy (`keepFresherRows`)
   * and dropped the listed pull requests — and every other window never asked
   * at all. REPORTED as a workflow shelf with no chip under a manager reading
   * "It's on draft PR #6490"; reconstructed from run `4f7ae5fa`: the result
   * at 14:02:32Z, a `GET /v1/workflows/runs` at 14:14:38Z that captured it,
   * the Engineer's turn end at 14:24:16Z that announced nothing.
   *
   * `status: null`, like the activity and hold announces beside it: this says
   * what the run HAS, never whether it is still going, and a status asserted
   * by an event that never read the run is the defect the nullable status
   * exists to prevent. Silent when nothing changed — a chat with no pull
   * requests is the common case and would otherwise broadcast an empty array
   * to every window on every turn and every listing.
   */
  private announce(runId: string, pullRequests: RunPullRequest[]): void {
    this.bus.publishRunStatus({ runId, status: null, pullRequests });
  }

  /**
   * Tell the activity ledger which pull requests THIS write added to the run.
   *
   * {@link announce} says what the run HOLDS, to every window, whenever that
   * changes; the ledger counts what a thread DID, once. So this is the
   * difference between the list the row carried and the list it carries now,
   * compared by the merge's own identity: the pass that stores a pull request
   * announces it and no later pass does, and one met twice in a single scan
   * (`gh pr create` on a branch that already has its pull request prints the
   * URL again) is announced once, at the sighting the merge kept. One the cap
   * dropped was never stored and is not announced.
   *
   * Published only once the row is written (persist-then-emit).
   */
  private async announceOpened(
    runId: string,
    carried: readonly RunPullRequest[],
    merged: readonly RunPullRequest[],
    em: EntityManager,
  ): Promise<void> {
    const known = new Set(carried.map(pullRequestKey));
    const added = merged.filter(
      (pullRequest) => !known.has(pullRequestKey(pullRequest)),
    );
    if (added.length === 0) {
      return;
    }
    const capturedAt = new Date().toISOString();
    const pullRequests: CapturedPullRequest[] = [];
    for (const pullRequest of added) {
      pullRequests.push({
        owner: pullRequest.owner,
        repo: pullRequest.repo,
        number: pullRequest.number,
        url: pullRequest.url,
        occurredAt: await this.openedAt(runId, pullRequest, capturedAt, em),
      });
    }
    this.bus.publishPullRequestsCaptured({ runId, pullRequests });
  }

  /**
   * When the agent opened `pullRequest`: the time of the transcript row that
   * reported it, not of this pass noticing it. A first scan of a long thread
   * recovers pull requests opened weeks ago, and dating them by the scan would
   * file every one of them under the day it ran.
   *
   * A time that cannot be read costs the event its date and nothing else — the
   * pull request is on the row already — so it is announced at `capturedAt`
   * with a warning rather than not at all.
   */
  private async openedAt(
    runId: string,
    pullRequest: RunPullRequest,
    capturedAt: string,
    em: EntityManager,
  ): Promise<string> {
    let why = 'no such row';
    try {
      const at = (
        await this.itemDao.earliestToolResultTimes(runId, [pullRequest.seq], em)
      ).get(pullRequest.seq);
      if (at !== undefined) {
        return at.toISOString();
      }
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
    this.logger.warn(
      `run ${runId}: could not read when ${pullRequestKey(pullRequest)} was opened (item ${pullRequest.seq}): ${why}; announcing it at the time it was captured`,
    );
    return capturedAt;
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
    const text = resultText(payload?.result);
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
