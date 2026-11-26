import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';
import type { ExpressionBuilder } from 'kysely';

import {
  CHAT_TEXT_KINDS,
  CHAT_TEXT_TRIGGERS,
  CREATE_CHAT_TEXT_TABLE,
  DROP_CHAT_TEXT_TABLE,
  DROP_RETIRED_CHAT_TEXT_TRIGGERS,
} from '../../../db/chat-text-index.ddl';
import { EMBEDDING_CHAT_MIN_CHARS } from '../../embeddings/embeddings.types';
import { Item } from '../../runs/entity/item.entity';
import type {
  ChatContextRow,
  ChatContextRun,
  ChatRunTextMatch,
  ChatTextDatabase,
  ChatTextMatch,
  GlobalChatSearchQuery,
} from '../chat.types';

/** The filters a chat search applies to the rows it may return. */
export type ChatSearchReach = Pick<
  GlobalChatSearchQuery,
  'includeArchived' | 'runId' | 'cwd' | 'activeSince' | 'activeUntil'
>;

/** A message search by meaning embeds, with the `items` rowid its cursors walk. */
export interface ChatEmbeddableRow {
  rowid: number;
  id: string;
  run_id: string;
  created_at: number;
  text: string;
}

const HIT_COLUMNS = [
  'i.id',
  'i.run_id',
  'i.member_id',
  'i.seq',
  'i.kind',
  'i.role',
  'i.created_at',
  'r.title',
  'r.cwd',
  'r.archived_at',
  'chat_text.text',
] as const;
import { activityWindowOf, runIdsActiveIn } from '../utils/run-activity';
import { notSystemAnalysis } from '../utils/system-analysis-filter';

function longEnoughToEmbed(
  eb: ExpressionBuilder<ChatTextDatabase, 'chat_text'>,
) {
  return eb(
    eb.fn<number>('length', [eb.fn<string>('trim', ['chat_text.text'])]),
    '>=',
    EMBEDDING_CHAT_MIN_CHARS,
  );
}

@Injectable()
export class ChatSearchIndexDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  /** The best `limit` rows matching a ready-made FTS5 query, best first. */
  match(
    options: ChatSearchReach,
    matchQuery: string,
    limit: number,
  ): Promise<ChatTextMatch[]> {
    return this.reachable(options)
      .select(HIT_COLUMNS)
      .select('chat_text.rank')
      .where('chat_text', 'match', matchQuery)
      .orderBy('chat_text.rank')
      .orderBy('i.created_at', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * Those of `itemIds` a search by meaning with `options` may return, as hits
   * without a rank: a message too short to embed is left out even when an
   * older index still holds its vector.
   */
  async meaningHitsAmong(
    options: ChatSearchReach,
    itemIds: readonly string[],
  ): Promise<Omit<ChatTextMatch, 'rank'>[]> {
    if (itemIds.length === 0) {
      return [];
    }
    return this.reachable(options)
      .select(HIT_COLUMNS)
      .where('i.id', 'in', [...itemIds])
      .where(longEnoughToEmbed)
      .execute();
  }

  /** The runs a search with `options` may return messages of. */
  async reachableRunIds(options: ChatSearchReach): Promise<string[]> {
    const rows = await this.reachable(options)
      .select('r.id')
      .distinct()
      .execute();
    return rows.map((row) => row.id);
  }

  /** How many messages search by meaning embeds with an `items` rowid in `(after, upTo]`, created at or after `createdAfter` (epoch ms) unless it is null: user and assistant messages long enough to mean something. */
  async embeddableCountBetween(
    after: number,
    upTo: number,
    createdAfter: number | null = null,
  ): Promise<number> {
    let query = this.embeddable()
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('i.rowid', '>', after)
      .where('i.rowid', '<=', upTo);
    if (createdAfter !== null) {
      query = query.where('i.created_at', '>=', createdAfter);
    }
    const row = await query.executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** The highest `items` rowid, the point both embedding cursors start from. */
  async newestItemRowid(): Promise<number> {
    const row = await this.database()
      .selectFrom('items')
      .select((eb) => eb.fn.max<number | null>('rowid').as('newest'))
      .executeTakeFirst();
    return Number(row?.newest ?? 0);
  }

  /** Embeddable messages below `rowid` (newest first) or above it (oldest first). */
  async embeddableRows(
    from: number,
    direction: 'before' | 'after',
    limit: number,
  ): Promise<ChatEmbeddableRow[]> {
    return this.embeddable()
      .select(['i.rowid', 'i.id', 'i.run_id', 'i.created_at', 'chat_text.text'])
      .where('i.rowid', direction === 'before' ? '<' : '>', from)
      .orderBy('i.rowid', direction === 'before' ? 'desc' : 'asc')
      .limit(limit)
      .execute();
  }

  async liveRunIds(): Promise<string[]> {
    const rows = await this.database()
      .selectFrom('runs')
      .select('id')
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => row.id);
  }

  /** Every indexed text row a search with `options` may return. */
  private reachable(options: ChatSearchReach) {
    let query = this.database()
      .selectFrom('chat_text')
      .innerJoin('items as i', 'i.rowid', 'chat_text.rowid')
      .innerJoin('runs as r', 'r.id', 'i.run_id')
      .where('i.deleted_at', 'is', null)
      .where('r.deleted_at', 'is', null)
      // A team builder's own chat, and a thread's or a team's
      // analysis, are listed nowhere a hit could open them: each lives in its
      // own surface.
      .where('r.edits_team_slug', 'is', null)
      .where('r.analysis_source_run_id', 'is', null)
      .where('r.analysis_team_slug', 'is', null)
      .where((eb) => notSystemAnalysis(eb, eb.ref('r.analysis_purpose')));
    if (!options.includeArchived) {
      query = query.where('r.archived_at', 'is', null);
    }
    if (options.runId) {
      query = query.where('i.run_id', '=', options.runId);
    }
    if (options.cwd) {
      query = query.where('r.cwd', '=', options.cwd);
    }
    const window = activityWindowOf(options);
    if (window !== undefined) {
      query = query.where(
        'r.id',
        'in',
        runIdsActiveIn(this.database(), window),
      );
    }
    return query;
  }

  /** User and assistant messages, archived chats included: what search by meaning embeds. */
  private embeddable() {
    return this.reachable({ includeArchived: true })
      .where('i.kind', '=', 'message')
      .where('i.role', 'in', ['user', 'assistant'])
      .where(longEnoughToEmbed);
  }

  /** The run a context read is about, or undefined when it is gone. */
  run(runId: string): Promise<ChatContextRun | undefined> {
    return (
      this.database()
        .selectFrom('runs')
        .select(['id', 'title', 'cwd', 'archived_at'])
        .where('id', '=', runId)
        .where('deleted_at', 'is', null)
        // The same reach as `match`: nothing a search cannot return.
        .where('edits_team_slug', 'is', null)
        .where('analysis_source_run_id', 'is', null)
        .where('analysis_team_slug', 'is', null)
        .where((eb) => notSystemAnalysis(eb, eb.ref('analysis_purpose')))
        .executeTakeFirst()
    );
  }

  /** One message or reasoning row of a run — the kinds a search returns. */
  row(runId: string, itemId: string): Promise<ChatContextRow | undefined> {
    return this.contextRows()
      .where('run_id', '=', runId)
      .where('id', '=', itemId)
      .where('kind', 'in', [...CHAT_TEXT_KINDS])
      .executeTakeFirst();
  }

  /**
   * Up to `count` messages and reasoning rows on one side of `target`, nearest
   * first. `(run_id, seq)` is not unique, so a tie on seq is broken by id —
   * the same order on both sides, so no row is read twice or skipped.
   */
  neighbours(
    target: Pick<ChatContextRow, 'run_id' | 'seq' | 'id'>,
    side: 'before' | 'after',
    count: number,
  ): Promise<ChatContextRow[]> {
    if (count === 0) {
      return Promise.resolve([]);
    }
    const before = side === 'before';
    return this.contextRows()
      .where('run_id', '=', target.run_id)
      .where('kind', 'in', [...CHAT_TEXT_KINDS])
      .where((eb) =>
        eb.or([
          eb('seq', before ? '<' : '>', target.seq),
          eb.and([
            eb('seq', '=', target.seq),
            eb('id', before ? '<' : '>', target.id),
          ]),
        ]),
      )
      .orderBy('seq', before ? 'desc' : 'asc')
      .orderBy('id', before ? 'desc' : 'asc')
      .limit(count)
      .execute();
  }

  /**
   * One run's messages matching a ready-made FTS5 query, at or below `maxSeq`,
   * oldest first — whatever kind of run it is. Reasoning is left out: what an
   * agent thought is not what it said. The match runs once over the whole
   * index as a list of rowids, and the run's rows are joined to their text by
   * rowid: with the match on the join, SQLite walks the run's messages and
   * runs the whole query again for each one.
   */
  runRowsMatching(
    runId: string,
    matchQuery: string,
    maxSeq: number,
    limit: number,
  ): Promise<ChatRunTextMatch[]> {
    return this.database()
      .selectFrom('items as i')
      .innerJoin('chat_text', 'chat_text.rowid', 'i.rowid')
      .select(['i.seq', 'i.member_id', 'i.created_at', 'chat_text.text'])
      .where('i.rowid', 'in', (eb) =>
        eb
          .selectFrom('chat_text as hit')
          .select('hit.rowid')
          .where('hit.chat_text', 'match', matchQuery),
      )
      .where('i.run_id', '=', runId)
      .where('i.kind', '=', 'message')
      .where('i.deleted_at', 'is', null)
      .where('i.seq', '<=', maxSeq)
      .orderBy('i.seq')
      .limit(limit)
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
        CHAT_TEXT_TRIGGERS.map((trigger) => trigger.name),
      )
      .execute();
    return new Set(rows.map((row) => row.name));
  }

  /** Create the FTS table when it does not exist yet. */
  async createTable(): Promise<void> {
    await this.em.getConnection().execute(CREATE_CHAT_TEXT_TABLE, [], 'run');
  }

  /**
   * Recreate the index from `items` and install its triggers, in ONE
   * transaction: a row written between the fill and the triggers would
   * otherwise be missed, and a crash part-way leaves the triggers absent,
   * which is what makes the next boot rebuild it. The table is dropped and
   * created again rather than emptied, so a changed definition takes effect.
   */
  async rebuild(): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ddl = (sql: string) =>
        connection.execute(sql, [], 'run', em.getTransactionContext());
      for (const statement of DROP_RETIRED_CHAT_TEXT_TRIGGERS) {
        await ddl(statement);
      }
      await ddl(DROP_CHAT_TEXT_TABLE);
      await ddl(CREATE_CHAT_TEXT_TABLE);
      const database = this.database(em);
      await database
        .insertInto('chat_text')
        .columns(['rowid', 'item_id', 'text'])
        .expression((eb) =>
          eb
            .selectFrom('items')
            .select(['rowid', 'id'])
            .select((inner) =>
              inner
                .fn<string>('json_extract', [
                  inner.ref('payload'),
                  inner.val('$.text'),
                ])
                .as('text'),
            )
            .where('kind', 'in', [...CHAT_TEXT_KINDS])
            .where((inner) =>
              inner(
                inner
                  .case()
                  .when(inner.fn('json_valid', [inner.ref('payload')]), '=', 1)
                  .then(
                    inner.fn('json_type', [
                      inner.ref('payload'),
                      inner.val('$.text'),
                    ]),
                  )
                  .end(),
                '=',
                'text',
              ),
            ),
        )
        .execute();
      for (const trigger of CHAT_TEXT_TRIGGERS) {
        await ddl(trigger.sql);
      }
    });
  }

  private contextRows() {
    return this.database()
      .selectFrom('items')
      .select([
        'id',
        'run_id',
        'member_id',
        'seq',
        'kind',
        'role',
        'payload',
        'created_at',
      ])
      .where('deleted_at', 'is', null);
  }

  private database(em = this.em) {
    return em.getKysely<ChatTextDatabase>({ convertValues: false });
  }
}
