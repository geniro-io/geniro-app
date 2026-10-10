import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { Item } from '../../runs/entity/item.entity';
import type {
  ChatEmbeddedChunk,
  ChatSearchDocument,
  ChatSearchVectorRow,
  GlobalChatSearchQuery,
  GlobalChatSearchRow,
} from '../chat-search.types';
import { ChatSearchChunk } from '../entity/chat-search-chunk.entity';

const SEARCH_COLUMNS = `i.id, i.run_id as runId, i.node_id as nodeId, i.seq, i.kind, i.role,
  i.search_text as searchText, i.created_at as createdAt, r.title, r.cwd, r.archived_at as archivedAt`;
const LIVE_ITEMS = `i.deleted_at is null and r.deleted_at is null and i.search_text <> ''`;

@Injectable()
export class ChatSearchIndexDao extends BaseDao<ChatSearchChunk> {
  constructor(em: EntityManager) {
    super(em, ChatSearchChunk);
  }

  async keywords(
    options: GlobalChatSearchQuery,
    terms: readonly string[],
    limit: number,
  ): Promise<GlobalChatSearchRow[]> {
    if (!terms.length) {
      return [];
    }
    const { sql, values } = this.scope(options);
    const matches = terms
      .map(() => "i.search_text like ? escape '\\'")
      .join(' and ');
    return this.em.getConnection().execute<GlobalChatSearchRow[]>(
      `select ${SEARCH_COLUMNS} from items i join runs r on r.id = i.run_id
       where ${LIVE_ITEMS} ${sql} and ${matches}
       order by i.created_at desc, i.id desc limit ?`,
      [
        ...values,
        ...terms.map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`),
        limit,
      ],
    );
  }

  async documents(
    afterId: string,
    modelKey: string,
  ): Promise<ChatSearchDocument[]> {
    return this.em.getConnection().execute<ChatSearchDocument[]>(
      `select i.id, i.payload, i.search_text as searchText, c.text_hash as textHash
       from items i join runs r on r.id = i.run_id
       left join chat_search_chunks c on c.item_id = i.id and c.model_key = ? and c.chunk_index = 0
       where ${LIVE_ITEMS} and i.kind = 'message' and i.id > ? order by i.id limit 150`,
      [modelKey, afterId],
    );
  }

  async vectors(
    options: GlobalChatSearchQuery,
    modelKey: string,
    afterId: string,
    afterChunk: number,
  ): Promise<ChatSearchVectorRow[]> {
    const { sql, values } = this.scope(options);
    return this.em.getConnection().execute<ChatSearchVectorRow[]>(
      `select ${SEARCH_COLUMNS}, c.chunk_index as chunkIndex, c.text_offset as textOffset, c.text_hash as textHash, c.vector
       from chat_search_chunks c join items i on i.id = c.item_id join runs r on r.id = i.run_id
       where ${LIVE_ITEMS} ${sql} and c.model_key = ?
         and (c.item_id > ? or (c.item_id = ? and c.chunk_index > ?))
       order by c.item_id, c.chunk_index limit 500`,
      [...values, modelKey, afterId, afterId, afterChunk],
    );
  }

  async save(
    document: ChatSearchDocument,
    modelKey: string,
    textHash: string,
    vectors: ChatEmbeddedChunk[],
  ): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const current = await em.execute<{ id: string }[]>(
        `select i.id from items i join runs r on r.id = i.run_id
         where ${LIVE_ITEMS} and i.id = ? and i.payload = ?`,
        [document.id, document.payload],
      );
      if (!current.length) {
        return;
      }
      await em.execute('delete from chat_search_chunks where item_id = ?', [
        document.id,
      ]);
      const now = Date.now();
      for (const [chunkIndex, chunk] of vectors.entries()) {
        await em.execute(
          `insert into chat_search_chunks (item_id, model_key, chunk_index, text_offset, text_hash, vector, created_at, updated_at, deleted_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, null)`,
          [
            document.id,
            modelKey,
            chunkIndex,
            chunk.textOffset,
            textHash,
            JSON.stringify(chunk.vector),
            now,
            now,
          ],
        );
      }
    });
  }

  async payloads(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) {
      return new Map();
    }
    const rows = await this.em
      .fork()
      .find(Item, { id: { $in: ids } }, { fields: ['id', 'payload'] });
    return new Map(rows.map((row) => [row.id, row.payload]));
  }

  async prune(): Promise<void> {
    await this.em.getConnection().execute(
      `delete from chat_search_chunks where item_id not in
       (select i.id from items i join runs r on r.id = i.run_id where ${LIVE_ITEMS})`,
    );
  }

  private scope(options: GlobalChatSearchQuery): {
    sql: string;
    values: string[];
  } {
    const conditions: string[] = [];
    const values: string[] = [];
    if (!options.includeArchived) {
      conditions.push('r.archived_at is null');
    }
    if (options.runId) {
      conditions.push('i.run_id = ?');
      values.push(options.runId);
    }
    if (options.cwd) {
      conditions.push('r.cwd = ?');
      values.push(options.cwd);
    }
    return {
      sql: conditions.map((condition) => `and ${condition}`).join(' '),
      values,
    };
  }
}
