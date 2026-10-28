import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import {
  CREATE_MEMORY_TEXT_TABLE,
  DROP_MEMORY_TEXT_TABLE,
  DROP_RETIRED_MEMORY_TEXT_TRIGGERS,
  MEMORY_TEXT_TRIGGERS,
} from '../../../db/memory-text-index.ddl';
import { Memory } from '../entity/memory.entity';
import type { MemoryStatus, MemoryTextDatabase } from '../memory.types';

/** Which entries a read or a full-text match may return. */
export interface MemoryMatchScope {
  statuses: readonly MemoryStatus[];
  /**
   * `visibleTo`: global entries plus this project's (null = global only).
   * `exactly`: entries filed under exactly this scope (null = global).
   */
  projects: { visibleTo: string | null } | { exactly: string | null };
}

@Injectable()
export class MemoryDao extends BaseDao<Memory> {
  constructor(em: EntityManager) {
    super(em, Memory);
  }

  /** One past the highest handle ever given, forgotten entries included. */
  async nextHandle(em: EntityManager): Promise<number> {
    const highest = await em.findOne(
      Memory,
      { handle: { $gt: 0 } },
      { orderBy: { handle: 'desc' }, fields: ['handle'], filters: false },
    );
    return (highest?.handle ?? 0) + 1;
  }

  async getByIds(
    ids: readonly string[],
    em: EntityManager = this.em,
  ): Promise<Memory[]> {
    return this.getAll({ id: { $in: [...ids] } }, undefined, em);
  }

  /**
   * Entries in a scope, by handle when `handles` is given — the one place the
   * scope rule is written, for reads as for search.
   */
  async getInScope(
    scope: MemoryMatchScope,
    handles?: readonly number[],
    em: EntityManager = this.em,
  ): Promise<Memory[]> {
    let query = this.scoped(scope, em).select('m.id');
    if (handles !== undefined) {
      if (handles.length === 0) {
        return [];
      }
      query = query.where('m.handle', 'in', [...handles]);
    }
    const ids = (await query.execute()).map((row) => row.id);
    // The status again on load: a forget landing between the two reads must
    // not hand back an entry that just left the scope.
    return ids.length === 0
      ? []
      : this.getAll(
          { id: { $in: ids }, status: { $in: [...scope.statuses] } },
          undefined,
          em,
        );
  }

  /** The ids of the best `limit` entries matching a ready-made FTS5 query. */
  async matchIds(
    matchQuery: string,
    scope: MemoryMatchScope,
    limit: number,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    const rows = await this.scoped(scope, em)
      .innerJoin('memories_fts', 'memories_fts.memory_id', 'm.id')
      .select('m.id')
      .where('memories_fts', 'match', matchQuery)
      .orderBy('memories_fts.rank')
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  /** Live rows of the given statuses in the given scope. */
  private scoped(scope: MemoryMatchScope, em: EntityManager) {
    const query = this.database(em)
      .selectFrom('memories as m')
      .where('m.deleted_at', 'is', null)
      .where('m.status', 'in', [...scope.statuses]);
    if ('visibleTo' in scope.projects) {
      const project = scope.projects.visibleTo;
      return query.where((eb) =>
        project === null
          ? eb('m.project_id', 'is', null)
          : eb.or([
              eb('m.project_id', 'is', null),
              eb('m.project_id', '=', project),
            ]),
      );
    }
    const project = scope.projects.exactly;
    return project === null
      ? query.where('m.project_id', 'is', null)
      : query.where('m.project_id', '=', project);
  }

  /**
   * Stamp entries as read just now, outside the entity: a flush would also
   * move `updatedAt`, which means the entry's text changed.
   */
  async touch(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database()
      .updateTable('memories')
      .set({ last_used_at: at.getTime() })
      .where('id', 'in', [...ids])
      .execute();
  }

  /** Which of the index's triggers exist. */
  async presentTriggers(): Promise<Set<string>> {
    const rows = await this.database()
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'trigger')
      .where(
        'name',
        'in',
        MEMORY_TEXT_TRIGGERS.map((trigger) => trigger.name),
      )
      .execute();
    return new Set(rows.map((row) => row.name));
  }

  /** Create the FTS table when it does not exist yet. */
  async createTable(): Promise<void> {
    await this.em.getConnection().execute(CREATE_MEMORY_TEXT_TABLE, [], 'run');
  }

  /**
   * Recreate the index from `memories` and install its triggers in one
   * transaction, as `ChatSearchIndexDao.rebuild` does and for its reasons.
   */
  async rebuild(): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ddl = (sql: string) =>
        connection.execute(sql, [], 'run', em.getTransactionContext());
      for (const statement of DROP_RETIRED_MEMORY_TEXT_TRIGGERS) {
        await ddl(statement);
      }
      await ddl(DROP_MEMORY_TEXT_TABLE);
      await ddl(CREATE_MEMORY_TEXT_TABLE);
      await this.database(em)
        .insertInto('memories_fts')
        .columns(['rowid', 'memory_id', 'title', 'body'])
        .expression((eb) =>
          eb.selectFrom('memories').select(['rowid', 'id', 'title', 'body']),
        )
        .execute();
      for (const trigger of MEMORY_TEXT_TRIGGERS) {
        await ddl(trigger.sql);
      }
    });
  }

  private database(em = this.em) {
    return em.getKysely<MemoryTextDatabase>({ convertValues: false });
  }
}
