import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';

@Injectable()
export class UsageEventDao extends BaseDao<UsageEvent> {
  constructor(em: EntityManager) {
    super(em, UsageEvent);
  }

  /**
   * Write one turn's usage, or do nothing if that turn is already recorded.
   * Answers whether the row was NEW, which is what lets the backfill report how
   * much history it actually recovered.
   *
   * The check is a read followed by a write rather than a caught constraint
   * violation, because the two writers are a bus subscriber and a boot-time
   * sweep that never run concurrently within one daemon, and one daemon per
   * userData directory is enforced by the instance lock. The unique index is
   * still there as the backstop — if that assumption ever stops holding, the
   * database refuses the duplicate instead of the ledger quietly double-counting
   * someone's spend.
   */
  async recordOnce(
    row: UsageEventInput,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const existing = await this.getRepo(txEm).findOne(
      { runId: row.runId, seq: row.seq },
      { fields: ['id'], disableIdentityMap: true },
    );
    if (existing) {
      return false;
    }
    await this.insertRow(row, txEm);
    return true;
  }

  /**
   * Write one run's POLLED spend, replacing whatever the ledger held for it —
   * or write nothing when nothing moved. Answers whether the row changed, which
   * is what decides whether an open Stats page is told to re-read.
   *
   * An upsert where {@link recordOnce} refuses a second write, because the two
   * rows mean different things: a turn happens once, while the poll restates
   * the same run's running total every time the account bills it again. ONE row per
   * run, keyed `(runId, POLLED_SPEND_SEQ)` and rewritten in place, is what lets
   * the ledger hold that total without ever holding it twice. The key is forced
   * here rather than trusted from the caller, since a polled row filed under a
   * turn's seq would be read as that turn. Read-then-write for `recordOnce`'s
   * reason — one writer per daemon — with the unique index as the backstop.
   */
  async recordPolledSpend(
    input: UsageEventInput,
    txEm?: EntityManager,
    /**
     * The run's polled row as a caller already read it ({@link polledSpendRows}),
     * null for none — a sweep over every priced run asks once, not per run.
     */
    known?: UsageEvent | null,
  ): Promise<boolean> {
    const row: UsageEventInput = { ...input, seq: POLLED_SPEND_SEQ };
    const existing =
      known !== undefined
        ? known
        : await this.getRepo(txEm).findOne(
            { runId: row.runId, seq: POLLED_SPEND_SEQ },
            { disableIdentityMap: true },
          );
    if (existing === null) {
      await this.insertRow(row, txEm);
      return true;
    }
    const moved = (Object.keys(row) as (keyof UsageEventInput)[]).some(
      (key) => {
        const next = row[key];
        const held = existing[key];
        return next instanceof Date && held instanceof Date
          ? next.getTime() !== held.getTime()
          : next !== held;
      },
    );
    if (!moved) {
      return false;
    }
    await this.getRepo(txEm).nativeUpdate({ id: existing.id }, row);
    return true;
  }

  /** The polled-spend rows of `runIds`, by run, read in ONE query. */
  async polledSpendRows(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, UsageEvent>> {
    if (runIds.length === 0) {
      return new Map();
    }
    const rows = await this.getRepo(txEm).find(
      { runId: { $in: [...runIds] }, seq: POLLED_SPEND_SEQ },
      { disableIdentityMap: true },
    );
    return new Map(rows.map((row) => [row.runId, row]));
  }

  /**
   * Insert one ledger row WITHOUT flushing the caller's unit of work.
   *
   * `BaseDao.create` flushes the whole EntityManager it is handed, and both
   * writers hand one that already holds the RUN they read the row's dimensions
   * from — which a flush writes back. Measured: the flush issued `update runs
   * set created_at = ?, updated_at = ?` for a run nothing had touched, so every
   * ledger write stamped its run's `updatedAt` with the moment of writing. A
   * boot sweep that recovered one turn re-dated every run the machine holds,
   * and a polled row — dated BY that column — moved its own date on each boot.
   * A native insert of a detached entity writes this row and nothing else, and
   * still gets the entity's own defaults (id, timestamps).
   */
  private async insertRow(
    row: UsageEventInput,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).insert(Object.assign(new UsageEvent(), row));
  }

  /**
   * Every turn recorded in a period, oldest first — the one query the whole
   * stats page is built on. Bounded by the range rather than paged: a row is a
   * handful of integers, and the aggregation needs all of them to bucket.
   *
   * The range is half-open (`from` inclusive, `to` exclusive) so consecutive
   * periods tile without a turn landing in both.
   *
   * Runs' POLLED-spend rows come back too, dated by their run's last activity —
   * a caller that counts turns tells them apart with `isPolledSpend`.
   */
  async inRange(
    from: Date,
    to: Date,
    txEm?: EntityManager,
  ): Promise<UsageEvent[]> {
    return this.getRepo(txEm).find(
      { occurredAt: { $gte: from, $lt: to } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * The `(runId, seq)` pairs already recorded, as a set of composite keys — what
   * the backfill filters its candidate items against.
   *
   * One projected query rather than a `findOne` per candidate: a profile with
   * thousands of turns would otherwise pay a round trip each, on every boot,
   * to learn that it has nothing to do.
   */
  async recordedKeys(since?: Date, txEm?: EntityManager): Promise<Set<string>> {
    const rows = await this.getRepo(txEm).find(
      since === undefined ? {} : { occurredAt: { $gte: since } },
      { fields: ['runId', 'seq'], disableIdentityMap: true },
    );
    return new Set(rows.map((row) => `${row.runId}:${row.seq}`));
  }

  /**
   * The most recent TURN the ledger holds, or null when it holds none — the
   * boot sweep's high-water mark.
   *
   * Polled-spend rows are left out: the mark answers "which transcript rows can
   * the ledger already hold", and a polled row is dated by its run's activity
   * rather than by any transcript row, so letting it set the mark could only
   * ever move the sweep's floor past a turn it has not recorded.
   */
  async latestOccurredAt(txEm?: EntityManager): Promise<Date | null> {
    const last = await this.getRepo(txEm).findOne(
      { seq: { $ne: POLLED_SPEND_SEQ } },
      {
        orderBy: { occurredAt: 'desc' },
        fields: ['occurredAt'],
        disableIdentityMap: true,
      },
    );
    return last ? last.occurredAt : null;
  }

  /**
   * When the ledger's history starts, or null when it holds nothing — what an
   * "all time" range resolves its lower bound to.
   */
  async earliestOccurredAt(txEm?: EntityManager): Promise<Date | null> {
    const first = await this.getRepo(txEm).findOne(
      {},
      {
        orderBy: { occurredAt: 'asc' },
        fields: ['occurredAt'],
        disableIdentityMap: true,
      },
    );
    return first ? first.occurredAt : null;
  }
}
