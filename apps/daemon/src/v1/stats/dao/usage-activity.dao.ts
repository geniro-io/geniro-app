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
  LineSnapshotRow,
  LinesPeak,
  PullRequestActivityInput,
  UsageActivityKind,
} from '../stats.types';

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
    return this.insertOnce(
      `thread:${runId}`,
      { kind: 'thread', runId, occurredAt },
      txEm,
    );
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
    const identity = `${input.owner}/${input.repo}#${input.number}`;
    return this.insertOnce(
      `pr:${input.runId}:${identity}`,
      {
        kind: 'pull_request',
        runId: input.runId,
        occurredAt: input.occurredAt,
        prOwner: input.owner,
        prRepo: input.repo,
        prNumber: input.number,
        prUrl: input.url,
      },
      txEm,
    );
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
    txEm?: EntityManager,
  ): Promise<UsageActivity[]> {
    return this.getRepo(txEm).find(
      { kind, occurredAt: { $gte: from, $lt: to } },
      { orderBy: { occurredAt: 'asc' }, disableIdentityMap: true },
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
   * The highest lines total each thread reached BEFORE a period starts, per count: the
   * baseline the period's growth is counted past. A thread absent from the map has no
   * earlier snapshot, so its whole total in the period counts as growth.
   *
   * One grouped statement for every thread together, the peak taken in the database. A
   * thread's history is every snapshot it has ever taken, and it grows with how often the
   * thread was measured, so reading the rows to find the highest one would cost more on
   * every stats request as the history did. A row with either count unmeasured is left out
   * whole, as the growth fold leaves it out.
   */
  async peakLinesBefore(
    runIds: readonly string[],
    before: Date,
    txEm?: EntityManager,
  ): Promise<Map<string, LinesPeak>> {
    const peaks = new Map<string, LinesPeak>();
    if (runIds.length === 0) {
      return peaks;
    }
    const rows = await this.getRepo(txEm)
      .createQueryBuilder('activity')
      .select([
        raw('activity.run_id as run_id'),
        raw('max(activity.lines_added) as lines_added'),
        raw('max(activity.lines_removed) as lines_removed'),
      ])
      .where({
        kind: 'lines',
        runId: { $in: [...new Set(runIds)] },
        occurredAt: { $lt: before },
        linesAdded: { $ne: null },
        linesRemoved: { $ne: null },
      })
      .groupBy('runId')
      // Unmapped, so the rows keep the aliases above: mapping would rename them to property names.
      .execute<
        { run_id: string; lines_added: number; lines_removed: number }[]
      >('all', false);
    for (const row of rows) {
      peaks.set(row.run_id, {
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
    dedupKey: string,
    fields: {
      kind: UsageActivityKind;
      runId: string;
      occurredAt: Date;
    } & Partial<UsageActivity>,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const existing = await this.getRepo(txEm).findOne(
      { dedupKey },
      { fields: ['id'], disableIdentityMap: true },
    );
    if (existing) {
      return false;
    }
    try {
      await this.getRepo(txEm).insert(
        Object.assign(new UsageActivity(), fields, { dedupKey }),
      );
    } catch (err) {
      if (err instanceof UniqueConstraintViolationException) {
        return false;
      }
      throw err;
    }
    return true;
  }
}
