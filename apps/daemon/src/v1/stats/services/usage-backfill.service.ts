import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { usageFiguresFromRaw } from '../../agents/utils/usage-figures';
import { UsageEventDao } from '../dao/usage-event.dao';
import type { UsageEventInput } from '../stats.types';

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
    try {
      await this.backfill();
    } catch (err) {
      // A ledger that could not be seeded is a page with gaps, not a daemon
      // that must refuse to start — every other feature works without it.
      this.logger.warn(
        `usage backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
    const rows = await this.itemDao.allTurnCompleteRows(since, em);
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

    let recovered = 0;
    for (const row of missing) {
      const figures = usageFiguresFromRaw(row.payload);
      if (!figures) {
        continue;
      }
      const run = runs.get(row.runId) ?? null;
      const node =
        row.nodeId === null
          ? null
          : (nodes.get(`${row.runId}:${row.nodeId}`) ?? null);
      const input: UsageEventInput = {
        runId: row.runId,
        nodeId: row.nodeId,
        seq: row.seq,
        occurredAt: row.createdAt,
        agentKind: node?.agentKind ?? run?.agentKind ?? null,
        model: node?.model ?? run?.model ?? null,
        cwd: run?.cwd ?? null,
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
