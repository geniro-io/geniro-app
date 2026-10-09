import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { pollsSpendFor } from '../../agents/utils/polled-spend';
import { readRunPullRequests } from '../../agents/utils/pull-request-capture';
import {
  turnMemberOf,
  usageFiguresFrom,
} from '../../agents/utils/usage-figures';
import type { Run } from '../../runs/entity/run.entity';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEventInput } from '../stats.types';
import {
  POLLED_SPEND_RUN_FIELDS,
  polledAgentKind,
  polledSpendRows,
  type PolledSpendRun,
} from '../utils/polled-spend';
import {
  forTurn,
  reportedModelOf,
  type UsageDimensions,
  usageDimensions,
} from '../utils/usage-dimensions';

/**
 * How far before the ledger's newest turn each launch re-reads. See
 * {@link UsageBackfillService.sweepFloor} for why a margin is needed at all.
 */
const SWEEP_OVERLAP_MS = 24 * 60 * 60 * 1_000;

/**
 * Every run column the activity sweep reads, and no others: a run row carries a
 * whole conversation's settings, and the sweep needs its identity, when it was
 * created and the pull requests it recorded. Typed through {@link ActivityRun},
 * so reading one more column without listing it here does not compile.
 */
const ACTIVITY_RUN_FIELDS = [
  'id',
  'createdAt',
  'pullRequests',
] as const satisfies readonly (keyof Run)[];

/** One pull request a run opened, as its own record names it. */
type OpenedPullRequest = ReturnType<typeof readRunPullRequests>[number];

type ActivityRun = Pick<Run, (typeof ACTIVITY_RUN_FIELDS)[number]>;

/**
 * Seeds the usage ledger from transcript rows that were written before it
 * existed — and repairs the one gap the live recorder cannot close by itself.
 *
 * Two jobs, one sweep. The ledger is newer than the conversations it accounts
 * for, so without this the Stats page would open empty on an install with a
 * year of history behind it. And because the recorder writes AFTER the bus
 * publishes, a daemon that dies in that window leaves one turn unrecorded; the
 * next boot picks it up here.
 *
 * Safe on every boot because a turn is keyed by its own transcript row —
 * re-running this recovers nothing it already holds, so there is no "have I
 * migrated yet" flag to keep, and no way for one to be wrong.
 *
 * What it CANNOT recover is a turn whose transcript row is already gone: a run
 * deleted before the ledger existed took its history with it, permanently. That
 * is the asymmetry the ledger exists to stop from recurring, not one it can
 * undo.
 *
 * The same two jobs are done for POLLED spend ({@link backfillPolledSpend}):
 * seeding the ledger's polled row for every run the poll priced before that row
 * existed, and repairing one the recorder missed — a daemon that died between
 * the poll's run write and the ledger write. It carries the same limit: a run
 * deleted before its polled row was written took that bill with it.
 *
 * The activity ledger ({@link backfillActivity}) is seeded the same way, from
 * the runs that still exist: a thread for each, and the pull requests each one
 * recorded. It carries the same limit — a run deleted before the ledger existed
 * took its thread and its pull requests with it.
 */
@Injectable()
export class UsageBackfillService implements OnModuleInit {
  private readonly logger = new Logger(UsageBackfillService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly usageDao: UsageEventDao,
    private readonly activityDao: UsageActivityDao,
    /** Which CLIs poll their spend — absent in a spec that prices no pool. */
    @Optional() private readonly adapters?: AgentAdapterRegistry,
  ) {}

  /**
   * How far back a launch re-reads: the newest turn the ledger holds, less a
   * generous margin — or nothing at all on a ledger that is still empty.
   *
   * The margin is what makes the watermark safe. Turns from different runs
   * interleave, so a turn slightly OLDER than the newest recorded one can still
   * be unrecorded: the daemon died between its item write and its ledger write
   * while another run's later turn got through. That window is milliseconds
   * wide, so a day of overlap is enormous headroom, and re-reading one day of
   * turns on each launch is bounded in a way that re-reading all of history is
   * not.
   */
  private async sweepFloor(em: EntityManager): Promise<Date | undefined> {
    const watermark = await this.usageDao.latestOccurredAt(em);
    return watermark === undefined || watermark === null
      ? undefined
      : new Date(watermark.getTime() - SWEEP_OVERLAP_MS);
  }

  /**
   * Awaited during startup rather than left to run behind the first request:
   * a page that opened onto a half-swept ledger would show a total that grew
   * while the user looked at it, which reads as the app losing track of their
   * money. The activity sweep is the one exception: it reads every run, and nothing
   * needs it before the window does, so it runs behind the boot.
   *
   * The cost is proportional to FINISHED TURNS rather than to transcript size,
   * which is a property of `Item`'s `kind` index — that index exists for this
   * query and nothing else, so removing it turns every launch into a full scan
   * of the user's whole history. It is logged with its duration, so a profile
   * large enough to make boot noticeable says so rather than being guessed at.
   */
  async onModuleInit(): Promise<void> {
    // Each sweep fails on its own: a transcript that could not be read is no
    // reason to leave the polled bills or the activity ledger unseeded, nor the
    // reverse. The model repair runs BEFORE the polled sweep, which files each
    // run's polled bill under the model that run's turns reported.
    for (const [name, sweep] of [
      ['usage backfill', () => this.backfill()],
      ['reported model repair', () => this.fileTurnsUnderReportedModel()],
      ['polled spend backfill', () => this.backfillPolledSpend()],
    ] as const) {
      try {
        await sweep();
      } catch (err) {
        // A ledger that could not be seeded is a page with gaps, not a daemon
        // that must refuse to start — every other feature works without it.
        this.logger.warn(
          `${name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // The activity sweep reads every run on every launch, and the window is not
    // answered until this method returns. Nothing needs it before then, so it runs
    // behind the boot, as the search-text backfill does.
    void this.backfillActivityQuietly();
  }

  /** {@link backfillActivity} with its failure logged rather than thrown. */
  private async backfillActivityQuietly(): Promise<void> {
    try {
      await this.backfillActivity();
    } catch (err) {
      this.logger.warn(
        `activity backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * File every recorded turn under the model its own transcript row says the
   * CLI ran on (`UsageEventDao.fileTurnsUnderReportedModel`) — the repair for
   * rows written while the ledger filed a turn under the model the run ASKED
   * for. A no-op once done, so it runs on every launch rather than behind a
   * marker that could be wrong.
   */
  async fileTurnsUnderReportedModel(): Promise<number> {
    const moved = await this.usageDao.fileTurnsUnderReportedModel(
      this.em.fork(),
    );
    if (moved > 0) {
      this.logger.log(
        `filed ${moved} recorded turn(s) under the model the CLI reported`,
      );
    }
    return moved;
  }

  /**
   * Restate every priced run's polled spend in the ledger, writing only the
   * rows that moved; returns how many did.
   *
   * Unbounded by a watermark, unlike the turn sweep, and cheap for the reason
   * that sweep is not: it reads RUNS, not transcript, and only the ones the
   * poll ever priced — one row per polled conversation the machine holds.
   * Re-running it is harmless because the row is keyed per run and rewritten
   * in place (`UsageEventDao.recordPolledSpend`), so an unchanged run writes
   * nothing.
   */
  async backfillPolledSpend(): Promise<number> {
    const em = this.em.fork();
    // Only the columns the row is built from, and untracked.
    const priced: PolledSpendRun[] = await this.runDao.getAll(
      { polledCostCents: { $gt: 0 } },
      {
        fields: [...POLLED_SPEND_RUN_FIELDS],
        disableIdentityMap: true,
      },
      em,
    );
    const held = await this.usageDao.polledSpendRows(
      priced.map((run) => run.id),
      em,
    );
    // Whose money a WORKFLOW run's bill is comes off its nodes' shares — one
    // read for every such run rather than one per run.
    const sharesByRun = new Map<
      string,
      Awaited<ReturnType<NodeStateDao['polledSharesForRuns']>>
    >();
    for (const share of await this.nodeStateDao.polledSharesForRuns(
      priced.filter((run) => run.agentKind === null).map((run) => run.id),
      em,
    )) {
      sharesByRun.set(share.runId, [
        ...(sharesByRun.get(share.runId) ?? []),
        share,
      ]);
    }
    const models = await this.usageDao.latestReportedModels(
      priced.map((run) => run.id),
      em,
    );
    let written = 0;
    for (const run of priced) {
      const agentKind = polledAgentKind(
        run,
        sharesByRun.get(run.id) ?? [],
        (kind) => pollsSpendFor(this.adapters?.all() ?? new Map(), kind),
      );
      const rows = polledSpendRows(
        run,
        agentKind,
        agentKind === null
          ? null
          : (models.get(run.id)?.get(agentKind) ?? null),
      );
      if (
        rows.length > 0 &&
        (await this.usageDao.recordPolledSpend(
          run.id,
          rows,
          em,
          held.get(run.id) ?? [],
        ))
      ) {
        written += 1;
      }
    }
    if (written > 0) {
      this.logger.log(
        `polled spend backfill restated ${written} of ${priced.length} priced run(s)`,
      );
    }
    return written;
  }

  /** Returns how many turns were recovered, and how many were already held. */
  async backfill(): Promise<{ recovered: number; scanned: number }> {
    const startedAt = Date.now();
    const em = this.em.fork();
    // Sweep only what the ledger cannot already hold. The first launch after
    // this module lands has no watermark and reads everything — that is the
    // seeding pass; every launch after it is bounded by how much happened since
    // the last one, so start-up stops growing with total history.
    const since = await this.sweepFloor(em);
    const rows = await this.itemDao.allUsageRows(since, em);
    if (rows.length === 0) {
      return { recovered: 0, scanned: 0 };
    }

    const known = await this.usageDao.recordedKeys(since, em);
    const missing = rows.filter((row) => !known.has(`${row.runId}:${row.seq}`));
    if (missing.length === 0) {
      return { recovered: 0, scanned: rows.length };
    }

    // Both dimension tables are read ONCE and indexed in memory. A lookup per
    // row would be two queries per turn on a sweep whose whole point is to be
    // cheap enough to run unconditionally at every boot.
    const runs = new Map(
      (await this.runDao.getAll({}, undefined, em)).map((run) => [run.id, run]),
    );
    const nodes = new Map(
      (await this.nodeStateDao.getAll({}, undefined, em)).map((node) => [
        `${node.runId}:${node.nodeId}`,
        node,
      ]),
    );

    // Once per (run, node) rather than per turn: the workflow's name is read
    // out of the run's snapshot, a whole workflow document, and a sweep that
    // re-parsed it for every turn of a long run would pay for the same string
    // thousands of times.
    const dimensionsByNode = new Map<string, UsageDimensions>();
    const dimensionsOf = (
      runId: string,
      nodeId: string | null,
    ): UsageDimensions => {
      const key = JSON.stringify([runId, nodeId]);
      const known = dimensionsByNode.get(key);
      if (known) {
        return known;
      }
      const fresh = usageDimensions(
        runs.get(runId) ?? null,
        nodeId === null ? null : (nodes.get(`${runId}:${nodeId}`) ?? null),
      );
      dimensionsByNode.set(key, fresh);
      return fresh;
    };

    let recovered = 0;
    for (const row of missing) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const figures = usageFiguresFrom(payload);
      if (!figures) {
        continue;
      }
      const dimensions = dimensionsOf(row.runId, row.nodeId);
      const input: UsageEventInput = {
        runId: row.runId,
        nodeId: row.nodeId,
        seq: row.seq,
        occurredAt: row.createdAt,
        // The same reading the live recorder takes: the model the CLI
        // reported, over the one the run asked for, and a pool member's own.
        ...forTurn(dimensions, reportedModelOf(payload), turnMemberOf(payload)),
        ...figures,
      };
      if (await this.usageDao.recordOnce(input, em)) {
        recovered += 1;
      }
    }

    if (recovered > 0) {
      this.logger.log(
        `usage backfill recovered ${recovered} turn(s) from ${rows.length} transcript row(s) in ${
          Date.now() - startedAt
        }ms`,
      );
    }
    return { recovered, scanned: rows.length };
  }

  /**
   * Seed the activity ledger from the runs that exist now: a `thread` row for
   * every run, and a `pull_request` row for every pull request a run's own
   * record says it opened. Returns how many rows of each kind it wrote.
   *
   * Cheap enough to repeat on every launch, so it keeps no marker that could be
   * wrong: it reads RUNS, and both writes are idempotent at the DAO — the
   * database refuses a second row for a thread or a pull request — so an
   * unchanged history writes nothing. The transcript is read for one fact only,
   * when a pull request was captured, every capture of the launch in one read
   * ({@link ItemDao.earliestToolResultTimesOf}).
   *
   * Beside the history from before the ledger it picks up what the live recorder
   * missed: a daemon that died between a run's insert and the ledger's.
   */
  async backfillActivity(): Promise<{ threads: number; pullRequests: number }> {
    const startedAt = Date.now();
    const em = this.em.fork();
    const runs: ActivityRun[] = await this.runDao.getAll(
      {},
      { fields: [...ACTIVITY_RUN_FIELDS], disableIdentityMap: true },
      em,
    );
    // Every run's pull requests are dated in ONE read of the transcript for the whole launch, not one
    // read per run that opened a pull request, and the runs below are then only written.
    const opened = new Map<string, readonly OpenedPullRequest[]>();
    for (const run of runs) {
      const captured = readRunPullRequests(run.pullRequests);
      if (captured.length > 0) {
        opened.set(run.id, captured);
      }
    }
    const capturedAt = await this.itemDao.earliestToolResultTimesOf(
      [...opened].flatMap(([runId, captured]) =>
        captured.map((pullRequest) => ({ runId, seq: pullRequest.seq })),
      ),
      em,
    );
    let threads = 0;
    let pullRequests = 0;
    for (const run of runs) {
      if (await this.activityDao.insertThreadOnce(run.id, run.createdAt, em)) {
        threads += 1;
      }
      pullRequests += await this.seedPullRequests(
        run,
        opened.get(run.id) ?? [],
        capturedAt.get(run.id),
        em,
      );
    }
    if (threads + pullRequests > 0) {
      this.logger.log(
        `activity backfill recorded ${threads} thread(s) and ${pullRequests} pull request(s) from ${runs.length} run(s) in ${
          Date.now() - startedAt
        }ms`,
      );
    }
    return { threads, pullRequests };
  }

  /**
   * Record each pull request one run opened; returns how many were new.
   *
   * A run keeps a pull request's identity and the `seq` of the transcript row it
   * was captured at, but not WHEN, and the Stats page counts it on the day it
   * was opened — so the date is that row's. With the row gone the run's own
   * creation stands in: the earliest day the thread could have opened it, which
   * counts the pull request somewhere rather than dropping it.
   */
  private async seedPullRequests(
    run: ActivityRun,
    opened: readonly OpenedPullRequest[],
    capturedAt: ReadonlyMap<number, Date> | undefined,
    em: EntityManager,
  ): Promise<number> {
    let recorded = 0;
    for (const pullRequest of opened) {
      const isNew = await this.activityDao.insertPullRequestOnce(
        {
          runId: run.id,
          owner: pullRequest.owner,
          repo: pullRequest.repo,
          number: pullRequest.number,
          url: pullRequest.url,
          occurredAt: capturedAt?.get(pullRequest.seq) ?? run.createdAt,
        },
        em,
      );
      if (isNew) {
        recorded += 1;
      }
    }
    return recorded;
  }
}
