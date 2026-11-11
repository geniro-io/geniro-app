import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { MemoryUsageBackfill } from '../entity/memory-usage-backfill.entity';
import { MemoryUsageDay } from '../entity/memory-usage-day.entity';
import type { MemoryUsageCount } from '../memory.types';

/**
 * The usage tables as SQLite stores them, typed off the entity properties;
 * dates are the stored epoch milliseconds, since value conversion is off.
 */
interface MemoryUsageDatabase {
  memory_usage_days: {
    memory_id: MemoryUsageDay['memoryId'];
    day: MemoryUsageDay['day'];
    reads: MemoryUsageDay['reads'];
    search_hits: MemoryUsageDay['searchHits'];
    index_shows: MemoryUsageDay['indexShows'];
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  memory_usage_backfill: {
    run_id: MemoryUsageBackfill['runId'];
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
}

/** Rows per {@link MemoryUsageDao.add} insert — 8 bound values each. */
const ADD_BATCH = 500;

@Injectable()
export class MemoryUsageDao extends BaseDao<MemoryUsageDay> {
  constructor(em: EntityManager) {
    super(em, MemoryUsageDay);
  }

  /**
   * Add these counts to the figures, one statement per {@link ADD_BATCH}
   * rows: an insert that adds onto the existing row on its `(memoryId, day)`
   * key, so concurrent writers never overwrite each other.
   */
  async add(
    counts: readonly MemoryUsageCount[],
    txEm?: EntityManager,
  ): Promise<void> {
    const merged = mergeCounts(counts);
    if (merged.length === 0) {
      return;
    }
    const db = this.database(txEm);
    const now = Date.now();
    for (let at = 0; at < merged.length; at += ADD_BATCH) {
      await db
        .insertInto('memory_usage_days')
        .values(
          merged.slice(at, at + ADD_BATCH).map((count) => ({
            memory_id: count.memoryId,
            day: count.day,
            reads: count.reads,
            search_hits: count.searchHits,
            index_shows: count.indexShows,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(['memory_id', 'day']).doUpdateSet((eb) => ({
            reads: eb('memory_usage_days.reads', '+', eb.ref('excluded.reads')),
            search_hits: eb(
              'memory_usage_days.search_hits',
              '+',
              eb.ref('excluded.search_hits'),
            ),
            index_shows: eb(
              'memory_usage_days.index_shows',
              '+',
              eb.ref('excluded.index_shows'),
            ),
            updated_at: now,
          })),
        )
        .execute();
    }
  }

  /** Every recorded day of these entries, oldest first. */
  async daysOf(
    memoryIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<MemoryUsageCount[]> {
    if (memoryIds.length === 0) {
      return [];
    }
    const rows = await this.database(txEm)
      .selectFrom('memory_usage_days')
      .select(['memory_id', 'day', 'reads', 'search_hits', 'index_shows'])
      .where('memory_id', 'in', [...memoryIds])
      .where('deleted_at', 'is', null)
      .orderBy('day')
      .orderBy('memory_id')
      .execute();
    return rows.map((row) => ({
      memoryId: row.memory_id,
      day: row.day,
      reads: Number(row.reads),
      searchHits: Number(row.search_hits),
      indexShows: Number(row.index_shows),
    }));
  }

  /** The runs the backfill has already counted. */
  async backfilledRunIds(txEm?: EntityManager): Promise<Set<string>> {
    const rows = await this.database(txEm)
      .selectFrom('memory_usage_backfill')
      .select('run_id')
      .execute();
    return new Set(rows.map((row) => row.run_id));
  }

  /** Record a run as counted; a second record of it changes nothing. */
  async markBackfilled(runId: string, txEm: EntityManager): Promise<void> {
    const now = Date.now();
    await this.database(txEm)
      .insertInto('memory_usage_backfill')
      .values({
        run_id: runId,
        created_at: now,
        updated_at: now,
        deleted_at: null,
      })
      .onConflict((conflict) => conflict.column('run_id').doNothing())
      .execute();
  }

  private database(txEm?: EntityManager) {
    return (txEm ?? this.em.fork()).getKysely<MemoryUsageDatabase>({
      convertValues: false,
    });
  }
}

function mergeCounts(counts: readonly MemoryUsageCount[]): MemoryUsageCount[] {
  const byKey = new Map<string, MemoryUsageCount>();
  for (const count of counts) {
    if (count.reads + count.searchHits + count.indexShows === 0) {
      continue;
    }
    const key = `${count.memoryId}\u0000${count.day}`;
    const held = byKey.get(key);
    byKey.set(
      key,
      held === undefined
        ? { ...count }
        : {
            ...held,
            reads: held.reads + count.reads,
            searchHits: held.searchHits + count.searchHits,
            indexShows: held.indexShows + count.indexShows,
          },
    );
  }
  return [...byKey.values()];
}
