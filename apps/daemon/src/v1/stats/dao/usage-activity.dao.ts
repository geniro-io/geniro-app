import { randomUUID } from 'node:crypto';

import {
  EntityManager,
  raw,
  UniqueConstraintViolationException,
} from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { UsageActivity } from '../entity/usage-activity.entity';
import type {
  ActivityFact,
  LineSnapshotRow,
  LinesPeak,
  PullRequestActivityInput,
  UsageActivityKind,
} from '../stats.types';
import { pullRequestFact, threadFact } from '../utils/activity-facts';
import { SNAPSHOT_LINE_KEY_SQL } from '../utils/line-keys';

/**
 * The durable record of what threads did (see the entity). The two facts that happen
 * once are written idempotently, so a boot sweep can re-run over history and the
 * database refuses a duplicate rather than relying on every caller to check first.
 */
@Injectable()
export class UsageActivityDao extends BaseDao<UsageActivity> {
  constructor(em: EntityManager) {
    super(em, UsageActivity);
  }

  /**
   * Record that a run was created, or do nothing if that is already recorded.
   *
   * @returns true when a row was written.
   */
  async insertThreadOnce(
    runId: string,
    occurredAt: Date,
    txEm?: EntityManager,
  ): Promise<boolean> {
    return this.insertOnce(threadFact(runId, occurredAt), txEm);
  }

  /**
   * Record a pull request a thread opened, or do nothing if that thread already
   * recorded it.
   *
   * @returns true when a row was written.
   */
  async insertPullRequestOnce(
    input: PullRequestActivityInput,
    txEm?: EntityManager,
  ): Promise<boolean> {
    return this.insertOnce(pullRequestFact(input), txEm);
  }

  /**
   * Write every fact the ledger does not already hold, for a sweep over the whole history:
   * the recorded keys are read ONCE, and the missing rows are written in one transaction.
   * A lookup per fact would cost a query per run on every launch to learn that nothing is
   * missing. A writer that takes a key in between is refused by the unique index, and that
   * fact counts as already recorded.
   *
   * @returns how many rows of each kind were written.
   */
  async insertMissing(
    facts: readonly ActivityFact[],
    txEm?: EntityManager,
  ): Promise<Record<ActivityFact['kind'], number>> {
    const written: Record<ActivityFact['kind'], number> = {
      thread: 0,
      pull_request: 0,
    };
    if (facts.length === 0) {
      return written;
    }
    const kinds = [...new Set(facts.map((fact) => fact.kind))];
    const known = new Set(
      (
        await this.getRepo(txEm).find(
          { kind: { $in: kinds } },
          { fields: ['dedupKey'], disableIdentityMap: true },
        )
      ).map((row) => row.dedupKey),
    );
    const missing = facts.filter((fact) => !known.has(fact.dedupKey));
    if (missing.length === 0) {
      return written;
    }
    await (txEm ?? this.em).transactional(async (tx) => {
      for (const fact of missing) {
        if (await this.insertFact(fact, tx)) {
          written[fact.kind] += 1;
        }
      }
    });
    return written;
  }

  /** Record one cumulative lines snapshot. Never refused, since a thread is measured many times. */
  async insertLineSnapshot(
    input: LineSnapshotRow,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).insert(
      Object.assign(new UsageActivity(), {
        kind: 'lines' as const,
        runId: input.runId,
        lineKey: input.lineKey,
        occurredAt: input.occurredAt,
        // The column is NOT NULL and unique, so a lines row takes a fresh key. Nothing
        // dedups on it.
        dedupKey: `lines:${randomUUID()}`,
        linesAdded: input.linesAdded,
        linesRemoved: input.linesRemoved,
        partial: input.partial,
      }),
    );
  }

  /**
   * Every fact of one kind recorded in a period, oldest first. The range is half-open,
   * which is what lets adjacent days share a boundary without counting a fact twice.
   */
  async inRange(
    kind: UsageActivityKind,
    from: Date,
    to: Date,
    fields: readonly (keyof UsageActivity & string)[],
    txEm?: EntityManager,
  ): Promise<UsageActivity[]> {
    return this.getRepo(txEm).find(
      { kind, occurredAt: { $gte: from, $lt: to } },
      {
        // The stats page reads this on every recorded turn, so it loads only what it folds.
        fields: [...fields],
        orderBy: { occurredAt: 'asc' },
        disableIdentityMap: true,
      },
    );
  }

  /**
   * The earliest row of the given kinds. The stats floor asks for threads and pull requests
   * only: a lines snapshot is dated by the desktop app, so counting it would let a client
   * move the floor (see `StatsService.recordLinesSnapshot`).
   */
  async earliestOccurredAt(
    kinds: readonly UsageActivityKind[],
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const row = await this.getRepo(txEm).findOne(
      { kind: { $in: [...kinds] } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
    );
    return row?.occurredAt ?? null;
  }

  /**
   * The highest lines total each series reached BEFORE a period starts, per count: the
   * baseline the period's growth is counted past. Keyed like `snapshotLineKey`. A series
   * absent from the map has no earlier snapshot, so its whole total in the period counts
   * as growth.
   *
   * One grouped statement for every series together, the peak taken in the database. A
   * series' history is every snapshot ever taken of it, and it grows with how often it was
   * measured, so reading the rows to find the highest one would cost more on every stats
   * request as the history did. A row with either count unmeasured is left out whole, as
   * the growth fold leaves it out.
   */
  async peakLinesBefore(
    series: readonly { runId: string; lineKey: string | null }[],
    before: Date,
    txEm?: EntityManager,
  ): Promise<Map<string, LinesPeak>> {
    const peaks = new Map<string, LinesPeak>();
    const lineKeys = new Set<string>();
    const legacyRunIds = new Set<string>();
    for (const row of series) {
      if (row.lineKey === null) {
        legacyRunIds.add(row.runId);
      } else {
        lineKeys.add(row.lineKey);
      }
    }
    if (lineKeys.size === 0 && legacyRunIds.size === 0) {
      return peaks;
    }
    const rows = await this.getRepo(txEm)
      .createQueryBuilder('activity')
      .select([
        // The same key `snapshotLineKey` gives a row, so the two maps cannot disagree.
        raw(`${SNAPSHOT_LINE_KEY_SQL} as series_key`),
        raw('max(activity.lines_added) as lines_added'),
        raw('max(activity.lines_removed) as lines_removed'),
      ])
      .where({
        kind: 'lines',
        occurredAt: { $lt: before },
        linesAdded: { $ne: null },
        linesRemoved: { $ne: null },
        $or: [
          ...(lineKeys.size > 0 ? [{ lineKey: { $in: [...lineKeys] } }] : []),
          ...(legacyRunIds.size > 0
            ? [{ lineKey: null, runId: { $in: [...legacyRunIds] } }]
            : []),
        ],
      })
      .groupBy(raw(SNAPSHOT_LINE_KEY_SQL))
      // Unmapped, so the rows keep the aliases above: mapping would rename them to property names.
      .execute<
        { series_key: string; lines_added: number; lines_removed: number }[]
      >('all', false);
    for (const row of rows) {
      peaks.set(row.series_key, {
        linesAdded: row.lines_added,
        linesRemoved: row.lines_removed,
      });
    }
    return peaks;
  }

  /**
   * Write one fact unless its key is already recorded. A writer that takes the key between
   * the lookup and this insert is refused by the unique index on `dedupKey`, and that refusal
   * answers the same question the lookup did: the fact is already recorded. It is not thrown
   * into a sweep, which would abort on the first such race.
   */
  private async insertOnce(
    fact: ActivityFact,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const existing = await this.getRepo(txEm).findOne(
      { dedupKey: fact.dedupKey },
      { fields: ['id'], disableIdentityMap: true },
    );
    if (existing) {
      return false;
    }
    return this.insertFact(fact, txEm);
  }

  /** Insert one fact; a key another writer already took answers false rather than throwing. */
  private async insertFact(
    fact: ActivityFact,
    txEm?: EntityManager,
  ): Promise<boolean> {
    try {
      await this.getRepo(txEm).insert(Object.assign(new UsageActivity(), fact));
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        return false;
      }
      throw err;
    }
    return true;
  }
}
