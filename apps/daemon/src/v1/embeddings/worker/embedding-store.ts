import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { type Kysely, sql } from 'kysely';
import { getLoadablePath } from 'sqlite-vec';

import {
  type ChatScore,
  type DocumentSource,
  EMBEDDING_DIM,
  EMBEDDING_MIN_SIMILARITY,
  EMBEDDING_VACUUM_SHARE,
  type EmbeddingCounts,
  type EmbeddingModelRef,
  type EmbeddingsDatabase,
  type SourceScore,
} from '../embeddings.types';
import { kyselyOverNodeSqlite } from './node-sqlite-dialect';

const SCHEMA_VERSION = '1';
const DELETED_SINCE_VACUUM = 'chat_deleted_since_vacuum';
const MAX_BOUND_IDS = 10_000;

export interface StoredDocument {
  sourceId: string;
  textHash: string;
  vectors: Float32Array[];
}

interface ChatRowFilter {
  itemId?: string;
  model?: string;
  notModel?: string;
  runIds?: readonly string[];
}

export interface StoredChatItem {
  itemId: string;
  runId: string;
  createdAt: number;
  textHash: string;
  vectors: Float32Array[];
}

export function modelKey(
  model: Pick<EmbeddingModelRef, 'id' | 'revision'>,
): string {
  return `${model.id}@${model.revision}`;
}

function floatBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function floatsOf(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/** Cosine is scale-free, so each vector is stretched to fill int8 before rounding. */
export function int8Blob(vector: Float32Array): Uint8Array {
  let peak = 0;
  for (const value of vector) {
    peak = Math.max(peak, Math.abs(value));
  }
  const scale = peak === 0 ? 0 : 127 / peak;
  const quantized = Int8Array.from(vector, (value) =>
    Math.round(value * scale),
  );
  return new Uint8Array(quantized.buffer);
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return sum;
}

function chunked<T>(values: readonly T[], size = MAX_BOUND_IDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

function bestPerKey<T extends { similarity: number }>(
  rows: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const seen = best.get(key);
    if (!seen || row.similarity > seen.similarity) {
      best.set(key, row);
    }
  }
  return [...best.values()]
    .filter((row) => row.similarity >= EMBEDDING_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * `embeddings.db`, opened by the embedding child only: memory and knowledge
 * vectors in a plain table scanned here, chat vectors in a `vec0` table.
 */
export class EmbeddingStore {
  private vacuumDue = false;

  private constructor(
    private readonly path: string,
    private readonly raw: DatabaseSync,
    private readonly db: Kysely<EmbeddingsDatabase>,
  ) {}

  static async open(path: string): Promise<EmbeddingStore> {
    const raw = new DatabaseSync(path, { allowExtension: true });
    raw.loadExtension(getLoadablePath());
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const store = new EmbeddingStore(path, raw, kyselyOverNodeSqlite(raw));
    await store.ensureSchema();
    await store.drainDeletions();
    return store;
  }

  close(): void {
    this.raw.close();
  }

  indexBytes(): number {
    return ['', '-wal', '-shm'].reduce((sum, suffix) => {
      try {
        return sum + statSync(this.path + suffix).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('meta')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) {
      await this.db.deleteFrom('meta').where('key', '=', key).execute();
      return;
    }
    await this.db
      .insertInto('meta')
      .values({ key, value })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value }))
      .execute();
  }

  async missingDocuments(
    source: DocumentSource,
    model: string,
    items: readonly { sourceId: string; textHash: string }[],
  ): Promise<string[]> {
    const stored = new Map<string, string>();
    for (const ids of chunked(items.map((item) => item.sourceId))) {
      const rows = await this.db
        .selectFrom('vectors')
        .select(['source_id', 'text_hash'])
        .where('source', '=', source)
        .where('model', '=', model)
        .where('chunk', '=', 0)
        .where('source_id', 'in', ids)
        .execute();
      for (const row of rows) {
        stored.set(row.source_id, row.text_hash);
      }
    }
    return items
      .filter((item) => stored.get(item.sourceId) !== item.textHash)
      .map((item) => item.sourceId);
  }

  async storeDocuments(
    source: DocumentSource,
    model: string,
    documents: readonly StoredDocument[],
  ): Promise<number> {
    await this.db.transaction().execute(async (tx) => {
      for (const document of documents) {
        await tx
          .deleteFrom('vectors')
          .where('source', '=', source)
          .where('source_id', '=', document.sourceId)
          .where('model', '=', model)
          .execute();
        if (document.vectors.length === 0) {
          continue;
        }
        await tx
          .insertInto('vectors')
          .values(
            document.vectors.map((vector, chunk) => ({
              source,
              source_id: document.sourceId,
              chunk,
              text_hash: document.textHash,
              model,
              vec: floatBlob(vector),
            })),
          )
          .execute();
      }
    });
    return documents.length;
  }

  async scoreDocuments(
    source: DocumentSource,
    model: string,
    query: Float32Array,
    sourceIds: readonly string[] | null,
    limit: number,
  ): Promise<SourceScore[]> {
    const scored: SourceScore[] = [];
    const scan = async (ids: readonly string[] | null) => {
      let read = this.db
        .selectFrom('vectors')
        .select(['source_id', 'vec'])
        .where('source', '=', source)
        .where('model', '=', model);
      if (ids !== null) {
        read = read.where('source_id', 'in', ids);
      }
      for (const row of await read.execute()) {
        scored.push({
          sourceId: row.source_id,
          similarity: dot(query, floatsOf(row.vec)),
        });
      }
    };
    if (sourceIds === null) {
      await scan(null);
    } else {
      for (const ids of chunked(sourceIds)) {
        await scan(ids);
      }
    }
    return bestPerKey(scored, (row) => row.sourceId).slice(0, limit);
  }

  async deleteDocuments(
    source: DocumentSource,
    sourceIds: readonly string[],
  ): Promise<number> {
    let deleted = 0;
    for (const ids of chunked(sourceIds)) {
      const result = await this.db
        .deleteFrom('vectors')
        .where('source', '=', source)
        .where('source_id', 'in', ids)
        .executeTakeFirst();
      deleted += Number(result.numDeletedRows);
    }
    return deleted;
  }

  async storeChatItems(
    model: string,
    items: readonly StoredChatItem[],
  ): Promise<number> {
    await this.db.transaction().execute(async (tx) => {
      for (const item of items) {
        await this.deleteChatRows(tx, { itemId: item.itemId, model });
        for (const [chunk, vector] of item.vectors.entries()) {
          const inserted = await tx
            .insertInto('chat_chunks')
            .values({
              id: null,
              run_id: item.runId,
              item_id: item.itemId,
              chunk,
              text_hash: item.textHash,
              created_at: item.createdAt,
              model,
            })
            .executeTakeFirstOrThrow();
          await tx
            .insertInto('chat_vec')
            .values({
              rowid: sql<number>`${BigInt(inserted.insertId ?? 0)}`,
              model,
              embedding: sql<Uint8Array>`vec_int8(${int8Blob(vector)})`,
            })
            .execute();
        }
      }
    });
    return items.length;
  }

  async missingChatItems(
    model: string,
    items: readonly { itemId: string; textHash: string }[],
  ): Promise<string[]> {
    const stored = new Map<string, string>();
    for (const ids of chunked(items.map((item) => item.itemId))) {
      const rows = await this.db
        .selectFrom('chat_chunks')
        .select(['item_id', 'text_hash'])
        .where('model', '=', model)
        .where('chunk', '=', 0)
        .where('item_id', 'in', ids)
        .execute();
      for (const row of rows) {
        stored.set(row.item_id, row.text_hash);
      }
    }
    return items
      .filter((item) => stored.get(item.itemId) !== item.textHash)
      .map((item) => item.itemId);
  }

  async searchChats(
    model: string,
    query: Float32Array,
    k: number,
    runIds: readonly string[] | null,
  ): Promise<ChatScore[]> {
    const blob = int8Blob(query);
    const hits: ChatScore[] = [];
    if (runIds === null) {
      const nearest = await this.db
        .selectFrom('chat_vec')
        .select(['rowid', sql<number>`distance`.as('distance')])
        .where('embedding', 'match', sql<Uint8Array>`vec_int8(${blob})`)
        .where(sql<boolean>`k = ${k}`)
        .where('model', '=', model)
        .execute();
      const rowids = nearest.map((row) => row.rowid);
      const distanceOf = new Map(
        nearest.map((row) => [row.rowid, row.distance]),
      );
      for (const ids of chunked(rowids)) {
        const chunks = await this.db
          .selectFrom('chat_chunks')
          .select(['id', 'item_id', 'run_id'])
          .where('id', 'in', ids)
          .execute();
        for (const chunk of chunks) {
          hits.push({
            itemId: chunk.item_id,
            runId: chunk.run_id,
            similarity: 1 - (distanceOf.get(chunk.id ?? -1) ?? 1),
          });
        }
      }
    } else {
      for (const ids of chunked(runIds)) {
        const rows = await this.db
          .selectFrom('chat_chunks as c')
          .innerJoin('chat_vec as v', 'v.rowid', 'c.id')
          .select([
            'c.item_id',
            'c.run_id',
            sql<number>`vec_distance_cosine(${sql.ref('v.embedding')}, vec_int8(${blob}))`.as(
              'distance',
            ),
          ])
          .where('c.model', '=', model)
          .where('c.run_id', 'in', ids)
          .orderBy('distance')
          .limit(k)
          .execute();
        for (const row of rows) {
          hits.push({
            itemId: row.item_id,
            runId: row.run_id,
            similarity: 1 - row.distance,
          });
        }
      }
    }
    return bestPerKey(hits, (row) => row.itemId).slice(0, k);
  }

  async deleteRuns(runIds: readonly string[]): Promise<number> {
    let deleted = 0;
    for (const ids of chunked(runIds)) {
      deleted += await this.deleteChatRows(this.db, { runIds: ids });
    }
    await this.noteChatDeletions(deleted);
    return deleted;
  }

  async keepRuns(runIds: readonly string[]): Promise<number> {
    const keep = new Set(runIds);
    const present = await this.db
      .selectFrom('chat_chunks')
      .select('run_id')
      .distinct()
      .execute();
    const gone = present
      .map((row) => row.run_id)
      .filter((runId) => !keep.has(runId));
    return gone.length === 0 ? 0 : this.deleteRuns(gone);
  }

  async counts(model: string): Promise<EmbeddingCounts> {
    const documents = await this.db
      .selectFrom('vectors')
      .select([
        'source',
        (eb) => eb.fn.count<number>('source_id').distinct().as('n'),
      ])
      .where('model', '=', model)
      .groupBy('source')
      .execute();
    const chats = await this.db
      .selectFrom('chat_chunks')
      .select((eb) => eb.fn.count<number>('item_id').distinct().as('n'))
      .where('model', '=', model)
      .executeTakeFirst();
    const of = (source: string) =>
      Number(documents.find((row) => row.source === source)?.n ?? 0);
    return {
      memory: of('memory'),
      knowledge: of('knowledge'),
      chats: Number(chats?.n ?? 0),
    };
  }

  /** Drop every row not written by `keep`: what is left of a replaced model. */
  async keepOnlyModel(keep: string): Promise<void> {
    await this.db.deleteFrom('vectors').where('model', '!=', keep).execute();
    const deleted = await this.deleteChatRows(this.db, { notModel: keep });
    await this.noteChatDeletions(deleted);
  }

  async clear(): Promise<void> {
    await this.db.deleteFrom('vectors').execute();
    await this.deleteChatRows(this.db, {});
    await this.db.deleteFrom('deletions').execute();
    await this.db
      .deleteFrom('meta')
      .where('key', '!=', 'schema_version')
      .execute();
    this.vacuumDue = true;
  }

  private async ensureSchema(): Promise<void> {
    await this.db.schema
      .createTable('meta')
      .ifNotExists()
      .addColumn('key', 'text', (c) => c.primaryKey())
      .addColumn('value', 'text', (c) => c.notNull())
      .execute();
    await this.db.schema
      .createTable('vectors')
      .ifNotExists()
      .addColumn('source', 'text', (c) => c.notNull())
      .addColumn('source_id', 'text', (c) => c.notNull())
      .addColumn('chunk', 'integer', (c) => c.notNull())
      .addColumn('text_hash', 'text', (c) => c.notNull())
      .addColumn('model', 'text', (c) => c.notNull())
      .addColumn('vec', 'blob', (c) => c.notNull())
      .addPrimaryKeyConstraint('vectors_pk', [
        'source',
        'source_id',
        'chunk',
        'model',
      ])
      .execute();
    await this.db.schema
      .createTable('chat_chunks')
      .ifNotExists()
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('run_id', 'text', (c) => c.notNull())
      .addColumn('item_id', 'text', (c) => c.notNull())
      .addColumn('chunk', 'integer', (c) => c.notNull())
      .addColumn('text_hash', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('model', 'text', (c) => c.notNull())
      .execute();
    await this.db.schema
      .createIndex('chat_chunks_item')
      .ifNotExists()
      .on('chat_chunks')
      .columns(['item_id', 'model', 'chunk'])
      .execute();
    await this.db.schema
      .createIndex('chat_chunks_run')
      .ifNotExists()
      .on('chat_chunks')
      .columns(['run_id', 'model'])
      .execute();
    await this.db.schema
      .createTable('deletions')
      .ifNotExists()
      .addColumn('source', 'text', (c) => c.notNull())
      .addColumn('source_id', 'text')
      .addColumn('run_id', 'text')
      .addColumn('queued_at', 'integer', (c) => c.notNull())
      .execute();
    if (EMBEDDING_DIM !== 768) {
      throw new Error('chat_vec is declared for 768 dimensions');
    }
    await sql`CREATE VIRTUAL TABLE IF NOT EXISTS chat_vec USING vec0(model text partition key, embedding int8[768] distance_metric=cosine)`.execute(
      this.db,
    );
    if ((await this.getMeta('schema_version')) === null) {
      await this.setMeta('schema_version', SCHEMA_VERSION);
    }
  }

  private async drainDeletions(): Promise<void> {
    const queued = await this.db.selectFrom('deletions').selectAll().execute();
    if (queued.length === 0) {
      return;
    }
    for (const source of ['memory', 'knowledge'] as const) {
      const ids = queued
        .filter((row) => row.source === source && row.source_id !== null)
        .map((row) => row.source_id as string);
      if (ids.length > 0) {
        await this.deleteDocuments(source, ids);
      }
    }
    const runIds = queued
      .filter((row) => row.source === 'chats' && row.run_id !== null)
      .map((row) => row.run_id as string);
    if (runIds.length > 0) {
      await this.deleteRuns(runIds);
    }
    await this.db.deleteFrom('deletions').execute();
  }

  private async deleteChatRows(
    db: Kysely<EmbeddingsDatabase>,
    which: ChatRowFilter,
  ): Promise<number> {
    let read = db.selectFrom('chat_chunks').select('id');
    if (which.itemId !== undefined) {
      read = read.where('item_id', '=', which.itemId);
    }
    if (which.model !== undefined) {
      read = read.where('model', '=', which.model);
    }
    if (which.notModel !== undefined) {
      read = read.where('model', '!=', which.notModel);
    }
    if (which.runIds !== undefined) {
      read = read.where('run_id', 'in', which.runIds);
    }
    const ids = (await read.execute())
      .map((row) => row.id)
      .filter((id): id is number => id !== null);
    for (const batch of chunked(ids)) {
      await db
        .deleteFrom('chat_vec')
        .where(
          'rowid',
          'in',
          batch.map((id) => sql<number>`${BigInt(id)}`),
        )
        .execute();
      await db.deleteFrom('chat_chunks').where('id', 'in', batch).execute();
    }
    return ids.length;
  }

  private async noteChatDeletions(deleted: number): Promise<void> {
    if (deleted === 0) {
      return;
    }
    const since =
      Number((await this.getMeta(DELETED_SINCE_VACUUM)) ?? 0) + deleted;
    const left = await this.db
      .selectFrom('chat_chunks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    if (since >= EMBEDDING_VACUUM_SHARE * (Number(left?.n ?? 0) + since)) {
      await this.setMeta(DELETED_SINCE_VACUUM, null);
      this.vacuumDue = true;
      return;
    }
    await this.setMeta(DELETED_SINCE_VACUUM, String(since));
  }

  /**
   * Give deleted rows' space back to the disk, when deletions asked for it.
   * The worker calls it only with no request in flight: SQLite refuses
   * `VACUUM` inside another request's open transaction.
   */
  vacuumIfDue(): void {
    if (!this.vacuumDue) {
      return;
    }
    this.raw.exec('VACUUM');
    this.vacuumDue = false;
  }
}
