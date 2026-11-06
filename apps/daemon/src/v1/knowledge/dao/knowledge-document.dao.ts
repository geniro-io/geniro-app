import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import {
  CREATE_KNOWLEDGE_TEXT_TABLE,
  DROP_KNOWLEDGE_TEXT_TABLE,
  DROP_RETIRED_KNOWLEDGE_TEXT_TRIGGERS,
  KNOWLEDGE_TEXT_RANK,
  KNOWLEDGE_TEXT_TRIGGERS,
} from '../../../db/knowledge-text-index.ddl';
import { KnowledgeDocument } from '../entity/knowledge-document.entity';
import type {
  KnowledgeHead,
  KnowledgeStatus,
  KnowledgeTextDatabase,
} from '../knowledge.types';
import { GLOBAL_PLACE_KEY } from '../utils/knowledge-text';

export interface KnowledgeHeadFilter {
  placeKeys?: readonly string[];
  statuses: readonly KnowledgeStatus[];
}

export interface KnowledgePageFilter {
  placeKey?: string;
  /** Rows filed in any of these places. */
  placeKeys?: readonly string[];
  handle?: string;
  /** Rows of these statuses, or with `waitingIds` everything under review. */
  statuses: readonly KnowledgeStatus[];
  /** Active documents with a change waiting; proposed ones always count. */
  waitingIds?: readonly string[];
  before?: { updatedAt: number; id: string };
  limit: number;
}

const HEAD_COLUMNS = [
  'id',
  'handle',
  'place_key',
  'project_id',
  'team_slug',
  'title',
  'when_to_read',
  'body_bytes',
  'status',
  'rev',
  'approved_at',
  'source_actor',
  'source_run_id',
  'source_agent_kind',
  'source_model',
  'last_read_at',
  'created_at',
  'updated_at',
] as const;

type HeadRow = Pick<
  KnowledgeTextDatabase['knowledge_documents'],
  (typeof HEAD_COLUMNS)[number]
>;

const dateOf = (at: number | null): Date | null =>
  at === null ? null : new Date(at);

function toHead(row: HeadRow): KnowledgeHead {
  return {
    id: row.id,
    handle: row.handle,
    placeKey: row.place_key,
    projectId: row.project_id,
    teamSlug: row.team_slug,
    title: row.title,
    whenToRead: row.when_to_read,
    bodyBytes: row.body_bytes,
    status: row.status,
    rev: row.rev,
    approvedAt: dateOf(row.approved_at),
    sourceActor: row.source_actor,
    sourceRunId: row.source_run_id,
    sourceAgentKind: row.source_agent_kind,
    sourceModel: row.source_model,
    lastReadAt: dateOf(row.last_read_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

@Injectable()
export class KnowledgeDocumentDao extends BaseDao<KnowledgeDocument> {
  constructor(em: EntityManager) {
    super(em, KnowledgeDocument);
  }

  /** Body-free rows of the given statuses, in the given places. */
  async heads(
    filter: KnowledgeHeadFilter,
    em: EntityManager = this.em,
  ): Promise<KnowledgeHead[]> {
    let query = this.database(em)
      .selectFrom('knowledge_documents')
      .select(HEAD_COLUMNS)
      .where('deleted_at', 'is', null)
      .where('status', 'in', [...filter.statuses]);
    if (filter.placeKeys !== undefined) {
      query = query.where('place_key', 'in', [...filter.placeKeys]);
    }
    return (await query.execute()).map(toHead);
  }

  async headById(
    id: string,
    em: EntityManager = this.em,
  ): Promise<KnowledgeHead | null> {
    const row = await this.database(em)
      .selectFrom('knowledge_documents')
      .select(HEAD_COLUMNS)
      .where('deleted_at', 'is', null)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toHead(row) : null;
  }

  /** The ids among `ids` matching a ready-made FTS5 query, best first. */
  async matchIds(
    matchQuery: string,
    ids: readonly string[],
    em: EntityManager = this.em,
  ): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.database(em)
      .selectFrom('knowledge_fts')
      .select('document_id')
      .where('knowledge_fts', 'match', matchQuery)
      .where('document_id', 'in', [...ids])
      .orderBy('rank')
      .execute();
    return rows.map((row) => row.document_id);
  }

  /** One page of the user's list, newest edit first. */
  async page(
    filter: KnowledgePageFilter,
    em: EntityManager = this.em,
  ): Promise<KnowledgeHead[]> {
    const { placeKey, placeKeys, handle, before, waitingIds, statuses } =
      filter;
    let query = this.database(em)
      .selectFrom('knowledge_documents')
      .select(HEAD_COLUMNS)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        waitingIds === undefined
          ? eb('status', 'in', [...statuses])
          : eb.or([
              eb('status', '=', 'proposed'),
              ...(waitingIds.length === 0
                ? []
                : [
                    eb.and([
                      eb('status', '=', 'active'),
                      eb('id', 'in', [...waitingIds]),
                    ]),
                  ]),
            ]),
      );
    if (placeKey !== undefined) {
      query = query.where('place_key', '=', placeKey);
    }
    if (placeKeys !== undefined) {
      query = query.where('place_key', 'in', [...placeKeys]);
    }
    if (handle !== undefined) {
      query = query.where('handle', '=', handle);
    }
    if (before !== undefined) {
      query = query.where((eb) =>
        eb.or([
          eb('updated_at', '<', before.updatedAt),
          eb.and([
            eb('updated_at', '=', before.updatedAt),
            eb('id', '<', before.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .limit(filter.limit)
      .execute();
    return rows.map(toHead);
  }

  /** The handles a place holds, whatever their status. */
  async handlesIn(
    placeKey: string,
    em: EntityManager = this.em,
  ): Promise<Set<string>> {
    const rows = await this.database(em)
      .selectFrom('knowledge_documents')
      .select('handle')
      .where('place_key', '=', placeKey)
      .execute();
    return new Set(rows.map((row) => row.handle));
  }

  /** Every document of a place, whatever its status, as id and handle. */
  async idsIn(
    placeKey: string,
    em: EntityManager = this.em,
  ): Promise<{ id: string; handle: string }[]> {
    return this.database(em)
      .selectFrom('knowledge_documents')
      .select(['id', 'handle'])
      .where('place_key', '=', placeKey)
      .execute();
  }

  /** How many documents of each status every place holds. */
  async countsByPlace(
    em: EntityManager = this.em,
  ): Promise<{ placeKey: string; status: KnowledgeStatus; count: number }[]> {
    const rows = await this.database(em)
      .selectFrom('knowledge_documents')
      .select(['place_key', 'status'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('deleted_at', 'is', null)
      .groupBy(['place_key', 'status'])
      .execute();
    return rows.map((row) => ({
      placeKey: row.place_key,
      status: row.status,
      count: Number(row.count),
    }));
  }

  /** File a document in Global under `handle`, in one statement. */
  async refileAsGlobal(
    id: string,
    handle: string,
    em: EntityManager,
  ): Promise<void> {
    await this.database(em)
      .updateTable('knowledge_documents')
      .set({
        handle,
        place_key: GLOBAL_PLACE_KEY,
        project_id: null,
        team_slug: null,
        updated_at: Date.now(),
      })
      .where('id', '=', id)
      .execute();
  }

  async deleteIds(ids: readonly string[], em: EntityManager): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database(em)
      .deleteFrom('knowledge_documents')
      .where('id', 'in', [...ids])
      .execute();
  }

  /**
   * Stamp documents as read just now, outside the entity: a flush would also
   * move `updatedAt`, which means the text changed.
   */
  async touch(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database()
      .updateTable('knowledge_documents')
      .set({ last_read_at: at.getTime() })
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
        KNOWLEDGE_TEXT_TRIGGERS.map((trigger) => trigger.name),
      )
      .execute();
    return new Set(rows.map((row) => row.name));
  }

  /** Create the FTS table when it does not exist yet. */
  async createTable(): Promise<void> {
    await this.em
      .getConnection()
      .execute(CREATE_KNOWLEDGE_TEXT_TABLE, [], 'run');
  }

  /** Stored in the table's own config, and lost with it. */
  async setRank(): Promise<void> {
    await this.em.getConnection().execute(KNOWLEDGE_TEXT_RANK, [], 'run');
  }

  /**
   * Recreate the index from `knowledge_documents` and install its triggers in
   * one transaction, as `ChatSearchIndexDao.rebuild` does and for its reasons.
   */
  async rebuild(): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ddl = (sql: string) =>
        connection.execute(sql, [], 'run', em.getTransactionContext());
      for (const statement of DROP_RETIRED_KNOWLEDGE_TEXT_TRIGGERS) {
        await ddl(statement);
      }
      await ddl(DROP_KNOWLEDGE_TEXT_TABLE);
      await ddl(CREATE_KNOWLEDGE_TEXT_TABLE);
      await this.database(em)
        .insertInto('knowledge_fts')
        .columns(['rowid', 'document_id', 'title', 'when_to_read', 'body'])
        .expression((eb) =>
          eb
            .selectFrom('knowledge_documents')
            .select(['rowid', 'id', 'title', 'when_to_read', 'body']),
        )
        .execute();
      for (const trigger of KNOWLEDGE_TEXT_TRIGGERS) {
        await ddl(trigger.sql);
      }
    });
  }

  private database(em = this.em) {
    return em.getKysely<KnowledgeTextDatabase>({ convertValues: false });
  }
}
