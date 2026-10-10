import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type {
  ChatEmbeddedChunk,
  ChatSearchDocument,
  ChatSearchVectorRow,
  GlobalChatSearchQuery,
  GlobalChatSearchRow,
} from '../chat-search.types';
import { ChatSearchChunk } from '../entity/chat-search-chunk.entity';

// Kysely returns stored timestamps unchanged when value conversion is disabled.
type StoredTimestamps = {
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};
interface ChatSearchDatabase {
  items: Pick<
    Item,
    | 'id'
    | 'runId'
    | 'nodeId'
    | 'seq'
    | 'kind'
    | 'role'
    | 'searchText'
    | 'payload'
  > &
    StoredTimestamps;
  runs: Pick<Run, 'id' | 'title' | 'cwd'> &
    StoredTimestamps & { archivedAt: number | null };
  chat_search_chunks: Pick<
    ChatSearchChunk,
    'itemId' | 'modelKey' | 'chunkIndex' | 'textOffset' | 'textHash' | 'vector'
  > &
    StoredTimestamps;
}

@Injectable()
export class ChatSearchIndexDao extends BaseDao<ChatSearchChunk> {
  constructor(em: EntityManager) {
    super(em, ChatSearchChunk);
  }

  async keywords(
    options: GlobalChatSearchQuery,
    terms: string[],
    limit: number,
  ): Promise<GlobalChatSearchRow[]> {
    if (!terms.length) {
      return [];
    }
    let query = this.scope(options);
    for (const term of terms) {
      query = query.where((eb) =>
        eb(
          eb.fn<number>('instr', [
            eb.fn('lower', ['i.searchText']),
            eb.val(term),
          ]),
          '>',
          0,
        ),
      );
    }
    return query
      .orderBy('i.createdAt', 'desc')
      .orderBy('i.id', 'desc')
      .limit(limit)
      .execute();
  }

  documents(afterId: string, modelKey: string): Promise<ChatSearchDocument[]> {
    return this.liveItems()
      .leftJoin('chat_search_chunks as c', (join) =>
        join
          .onRef('c.itemId', '=', 'i.id')
          .on('c.modelKey', '=', modelKey)
          .on('c.chunkIndex', '=', 0),
      )
      .select(['i.id', 'i.payload', 'c.textHash'])
      .select((eb) => eb.ref('i.searchText').$notNull().as('searchText'))
      .where('i.kind', '=', 'message')
      .where('i.id', '>', afterId)
      .orderBy('i.id')
      .limit(150)
      .execute();
  }

  vectors(
    options: GlobalChatSearchQuery,
    modelKey: string,
    afterId: string,
    afterChunk: number,
  ): Promise<ChatSearchVectorRow[]> {
    return this.scope(options)
      .innerJoin('chat_search_chunks as c', 'c.itemId', 'i.id')
      .select(['c.chunkIndex', 'c.textOffset', 'c.textHash', 'c.vector'])
      .where('c.modelKey', '=', modelKey)
      .where((eb) =>
        eb.or([
          eb('c.itemId', '>', afterId),
          eb.and([
            eb('c.itemId', '=', afterId),
            eb('c.chunkIndex', '>', afterChunk),
          ]),
        ]),
      )
      .orderBy('c.itemId')
      .orderBy('c.chunkIndex')
      .limit(500)
      .execute();
  }

  async save(
    document: ChatSearchDocument,
    modelKey: string,
    textHash: string,
    vectors: ChatEmbeddedChunk[],
  ): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const current = await this.liveItems(em)
        .select('i.id')
        .where('i.id', '=', document.id)
        .where('i.payload', '=', document.payload)
        .executeTakeFirst();
      if (!current) {
        return;
      }
      const database = this.database(em);
      await database
        .deleteFrom('chat_search_chunks')
        .where('itemId', '=', document.id)
        .execute();
      const now = Date.now();
      for (const [chunkIndex, chunk] of vectors.entries()) {
        await database
          .insertInto('chat_search_chunks')
          .values({
            itemId: document.id,
            modelKey,
            chunkIndex,
            textOffset: chunk.textOffset,
            textHash,
            vector: JSON.stringify(chunk.vector),
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .execute();
      }
    });
  }

  async payloads(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) {
      return new Map();
    }
    const rows = await this.database()
      .selectFrom('items')
      .select(['id', 'payload'])
      .where('id', 'in', ids)
      .where('deletedAt', 'is', null)
      .execute();
    return new Map(rows.map((row) => [row.id, row.payload]));
  }

  async prune(): Promise<void> {
    await this.database()
      .deleteFrom('chat_search_chunks')
      .where('itemId', 'not in', this.liveItems().select('i.id'))
      .execute();
  }

  private database(em = this.em) {
    return em.getKysely<ChatSearchDatabase>({
      columnNamingStrategy: 'property',
      convertValues: false,
    });
  }

  private liveItems(em = this.em) {
    return this.database(em)
      .selectFrom('items as i')
      .innerJoin('runs as r', 'r.id', 'i.runId')
      .where('i.deletedAt', 'is', null)
      .where('r.deletedAt', 'is', null)
      .where('i.searchText', '!=', '');
  }

  private scope(options: GlobalChatSearchQuery) {
    let query = this.liveItems()
      .select([
        'i.id',
        'i.runId',
        'i.nodeId',
        'i.seq',
        'i.kind',
        'i.role',
        'i.createdAt',
        'r.title',
        'r.cwd',
        'r.archivedAt',
      ])
      .select((eb) => eb.ref('i.searchText').$notNull().as('searchText'));
    if (!options.includeArchived) {
      query = query.where('r.archivedAt', 'is', null);
    }
    if (options.runId) {
      query = query.where('i.runId', '=', options.runId);
    }
    if (options.cwd) {
      query = query.where('r.cwd', '=', options.cwd);
    }
    return query;
  }
}
