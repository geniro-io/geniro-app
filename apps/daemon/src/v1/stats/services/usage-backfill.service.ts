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
import {
  turnMemberOf,
  usageFiguresFrom,
} from '../../agents/utils/usage-figures';
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
 */
/**
 * How far before the ledger's newest turn each launch re-reads. See
 * {@link UsageBackfillService.sweepFloor} for why a margin is needed at all.
 */
const SWEEP_OVERLAP_MS = 24 * 60 * 60 * 1_000;

@Injectable()
export class UsageBackfillService implements OnModuleInit {
  private readonly logger = new Logger(UsageBackfillService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly usageDao: UsageEventDao,
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
   * money.
   *
   * The cost is proportional to FINISHED TURNS rather than to transcript size,
   * which is a property of `Item`'s `kind` index — that index exists for this
   * query and nothing else, so removing it turns every launch into a full scan
   * of the user's whole history. It is logged with its duration, so a profile
   * large enough to make boot noticeable says so rather than being guessed at.
   */
  async onModuleInit(): Promise<void> {
    // Two sweeps, each failing on its own: a transcript that could not be read
    // is no reason to leave the polled bills unseeded, nor the reverse.
    // The model repair runs BEFORE the polled sweep, which files each run's
    // polled bill under the model that run's turns reported.
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
}
