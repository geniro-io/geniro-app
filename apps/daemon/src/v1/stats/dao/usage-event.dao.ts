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
   * Write one run's POLLED spend — its whole set of rows (`polledSpendRows`,
   * one per day and model) — replacing whatever the ledger held for it, or
   * write nothing when nothing moved. Answers whether anything changed, which
   * is what decides whether an open Stats page is told to re-read.
   *
   * An upsert where {@link recordOnce} refuses a second write, because the two
   * mean different things: a turn happens once, while the poll restates the
   * same run's bill every time the account bills it again. The run's rows are
   * keyed `(runId, seq ≤ POLLED_SPEND_SEQ)` and the SET is replaced — a row
   * whose bucket no longer exists is deleted — which is what lets the ledger
   * hold that bill without ever holding it twice. Every row is forced into the
   * polled range here rather than trusted from the caller, since a polled row
   * filed under a turn's seq would be read as that turn.
   */
  async recordPolledSpend(
    runId: string,
    rows: readonly UsageEventInput[],
    txEm?: EntityManager,
    /**
     * The run's polled rows as a caller already read them
     * ({@link polledSpendRows}) — a sweep over every priced run asks once.
     */
    known?: readonly UsageEvent[],
  ): Promise<boolean> {
    const held =
      known ??
      (await this.getRepo(txEm).find(
        { runId, seq: { $lte: POLLED_SPEND_SEQ } },
        { disableIdentityMap: true },
      ));
    const bySeq = new Map(held.map((row) => [row.seq, row]));
    let changed = false;
    const kept = new Set<number>();
    for (const input of rows) {
      const row: UsageEventInput = {
        ...input,
        runId,
        seq: Math.min(input.seq, POLLED_SPEND_SEQ),
      };
      kept.add(row.seq);
      const existing = bySeq.get(row.seq);
      if (existing === undefined) {
        await this.insertRow(row, txEm);
        changed = true;
        continue;
      }
      const moved = (Object.keys(row) as (keyof UsageEventInput)[]).some(
        (key) => {
          const next = row[key];
          const was = existing[key];
          return next instanceof Date && was instanceof Date
            ? next.getTime() !== was.getTime()
            : next !== was;
        },
      );
      if (moved) {
        await this.getRepo(txEm).nativeUpdate({ id: existing.id }, row);
        changed = true;
      }
    }
    const stale = held.filter((row) => !kept.has(row.seq)).map((row) => row.id);
    if (stale.length > 0) {
      await this.getRepo(txEm).nativeDelete({ id: { $in: stale } });
      changed = true;
    }
    return changed;
  }

  /** The polled-spend rows of `runIds`, by run, read in ONE query. */
  async polledSpendRows(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, UsageEvent[]>> {
    const out = new Map<string, UsageEvent[]>();
    if (runIds.length === 0) {
      return out;
    }
    const rows = await this.getRepo(txEm).find(
      { runId: { $in: [...runIds] }, seq: { $lte: POLLED_SPEND_SEQ } },
      { disableIdentityMap: true },
    );
    for (const row of rows) {
      out.set(row.runId, [...(out.get(row.runId) ?? []), row]);
    }
    return out;
  }

  /**
   * The model the newest of a run's own TURNS of one CLI reported running on,
   * or null — what that run's POLLED row is filed under, the poll itself
   * knowing nothing but money.
   */
  async latestReportedModel(
    runId: string,
    agentKind: string | null,
    txEm?: EntityManager,
  ): Promise<string | null> {
    if (agentKind === null) {
      return null;
    }
    const row = await this.getRepo(txEm).findOne(
      {
        runId,
        agentKind: agentKind as UsageEvent['agentKind'],
        seq: { $gt: POLLED_SPEND_SEQ },
        model: { $ne: null },
      },
      {
        orderBy: { occurredAt: 'desc' },
        fields: ['model'],
        disableIdentityMap: true,
      },
    );
    return row?.model ?? null;
  }

  /**
   * {@link latestReportedModel} for many runs in ONE query — what the boot
   * sweep over every priced run asks, by run and then by CLI.
   */
  async latestReportedModels(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    if (runIds.length === 0) {
      return out;
    }
    const rows = await this.getRepo(txEm).find(
      {
        runId: { $in: [...runIds] },
        seq: { $gt: POLLED_SPEND_SEQ },
        agentKind: { $ne: null },
        model: { $ne: null },
      },
      {
        orderBy: { occurredAt: 'asc' },
        fields: ['runId', 'agentKind', 'model'],
        disableIdentityMap: true,
      },
    );
    // Oldest first, so the newest turn of each run and CLI is the one kept.
    for (const row of rows) {
      if (row.agentKind === null || row.model === null) {
        continue;
      }
      const byKind = out.get(row.runId) ?? new Map<string, string>();
      byKind.set(row.agentKind, row.model);
      out.set(row.runId, byKind);
    }
    return out;
  }

  /**
   * File every recorded turn under the model its transcript row says the CLI
   * RAN on, where the two differ — returns how many rows moved.
   *
   * The ledger used to file a turn under the model the run ASKED for, which
   * is null whenever the CLI picked — 18% of a real ledger's spend sat under
   * a "CLI default" row naming no model. One statement against the turn rows'
   * own transcript rows (the `(run_id, seq)` index serves the join), so it is
   * cheap enough to run on every launch and moves nothing once done; a turn
   * whose transcript row is gone keeps what it had.
   */
  async fileTurnsUnderReportedModel(txEm?: EntityManager): Promise<number> {
    const em = txEm ?? this.em;
    const reported = `json_extract(i.payload, '$.usage.contextModel')`;
    const result = await em.getConnection().execute(
      `update usage_events set model = ${reported}
         from items i
        where i.run_id = usage_events.run_id
          and i.seq = usage_events.seq
          and usage_events.seq >= 0
          and json_valid(i.payload)
          and ${reported} is not null
          and ${reported} <> ''
          and (usage_events.model is null or usage_events.model <> ${reported})`,
      [],
      'run',
    );
    return (result as { affectedRows?: number }).affectedRows ?? 0;
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
      { seq: { $gt: POLLED_SPEND_SEQ } },
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
