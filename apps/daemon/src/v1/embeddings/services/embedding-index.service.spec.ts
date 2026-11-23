import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type Observable, Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import {
  type ChatSourceProvider,
  type ChatSourceRow,
  DEFAULT_EMBEDDING_CONFIG,
  type DocumentSource,
  type DocumentSourceProvider,
  type EmbeddingConfig,
  type EmbeddingModelRef,
  type EmbedDocument,
  type WorkerOp,
  type WorkerRequest,
  type WorkerRequestOf,
  type WorkerResults,
} from '../embeddings.types';
import { EmbeddingIndexService } from './embedding-index.service';
import {
  type EmbeddingProcessEvent,
  type EmbeddingProcessService,
  EmbeddingUnavailableError,
} from './embedding-process.service';

const MODEL: EmbeddingModelRef = {
  id: 'gemma',
  revision: 'rev-1',
  dir: '/models/gemma',
  dim: 768,
};
const NEXT: EmbeddingModelRef = {
  id: 'gemma',
  revision: 'rev-2',
  dir: '/models/gemma-2',
  dim: 768,
};
const THIRD: EmbeddingModelRef = { ...NEXT, revision: 'rev-3', dir: '/m/3' };
const ON: EmbeddingConfig = {
  enabled: true,
  model: MODEL,
  pendingModel: null,
  onBattery: false,
};
const CHAT_PAGE = 32;

type Handler<Op extends WorkerOp> = (
  request: WorkerRequestOf<Op>,
) => WorkerResults[Op] | Promise<WorkerResults[Op]>;
type FakeHandlers = { [Op in WorkerOp]?: Handler<Op> };

/**
 * The embedding child as the index service sees it: each request is recorded,
 * and the answers come from a small in-memory store of text hashes, so the
 * backfill and the stale checks behave as they do against the real child.
 */
class FakeEmbeddingProcess {
  alive = true;
  failure: string | null = null;
  stops = 0;
  forgiveCalls = 0;
  readonly requests: WorkerRequest[] = [];
  readonly modelCalls: {
    active: EmbeddingModelRef | null;
    pending: EmbeddingModelRef | null;
  }[] = [];
  readonly handlers: FakeHandlers = {};
  readonly stored: Record<DocumentSource, Map<string, string>> = {
    memory: new Map(),
    knowledge: new Map(),
  };
  readonly chats = new Map<string, string>();
  readonly meta = new Map<string, string>();
  private readonly events = new Subject<EmbeddingProcessEvent>();

  constructor(readonly dbPath: string) {}

  changes(): Observable<EmbeddingProcessEvent> {
    return this.events.asObservable();
  }

  async setModels(
    active: EmbeddingModelRef | null,
    pending: EmbeddingModelRef | null,
  ): Promise<void> {
    this.modelCalls.push({ active, pending });
  }

  forgiveFailures(): void {
    this.forgiveCalls += 1;
  }

  stop(): void {
    this.stops += 1;
    this.alive = false;
  }

  async request<Op extends WorkerOp>(
    request: WorkerRequestOf<Op>,
    _timeoutMs: number,
  ): Promise<WorkerResults[Op]> {
    this.requests.push(request);
    const override = this.handlers[request.op] as Handler<Op> | undefined;
    if (override) {
      return override(request);
    }
    return this.answer(request) as WorkerResults[Op];
  }

  answer(request: WorkerRequest): unknown {
    switch (request.op) {
      case 'open':
        return { indexBytes: 0 };
      case 'missing':
        return request.items
          .filter(
            (item) =>
              this.stored[request.source].get(item.sourceId) !== item.textHash,
          )
          .map((item) => item.sourceId);
      case 'index':
        for (const document of request.documents) {
          this.stored[request.source].set(document.sourceId, document.textHash);
        }
        return { stored: request.documents.length };
      case 'delete': {
        let deleted = 0;
        for (const sourceId of request.sourceIds) {
          if (this.stored[request.source].delete(sourceId)) {
            deleted += 1;
          }
        }
        return { deleted };
      }
      case 'indexChats':
        for (const item of request.items) {
          this.chats.set(item.itemId, item.textHash);
        }
        return { stored: request.items.length };
      case 'counts':
        return {
          memory: this.stored.memory.size,
          knowledge: this.stored.knowledge.size,
          chats: this.chats.size,
          indexBytes: 0,
        };
      case 'getMeta':
        return this.meta.get(request.key) ?? null;
      case 'setMeta':
        if (request.value === null) {
          this.meta.delete(request.key);
        } else {
          this.meta.set(request.key, request.value);
        }
        return null;
      case 'score':
      case 'searchChats':
        return [];
      case 'deleteRuns':
      case 'keepRuns':
        return { deleted: 0 };
      default:
        return null;
    }
  }
}

/** Memory or knowledge, as the module that owns the rows answers for them. */
class FakeDocuments implements DocumentSourceProvider {
  private readonly current = new Map<string, EmbedDocument>();

  constructor(readonly source: DocumentSource) {}

  set(sourceId: string, text: string): void {
    this.current.set(sourceId, {
      sourceId,
      textHash: `hash-${text}`,
      chunks: [text],
    });
  }

  remove(sourceId: string): void {
    this.current.delete(sourceId);
  }

  async inventory(): Promise<{ sourceId: string; textHash: string }[]> {
    return [...this.current.values()].map(({ sourceId, textHash }) => ({
      sourceId,
      textHash,
    }));
  }

  async documents(sourceIds: readonly string[]): Promise<EmbedDocument[]> {
    return sourceIds.flatMap((id) => {
      const document = this.current.get(id);
      return document ? [document] : [];
    });
  }
}

/** Chat history in `items` order; `before` and `after` read it the way the dao does. */
class FakeChats implements ChatSourceProvider {
  readonly rows: ChatSourceRow[] = [];
  readonly beforeCalls: number[] = [];
  readonly afterCalls: number[] = [];

  add(rowid: number, runId: string): void {
    this.rows.push({
      rowid,
      itemId: `c${rowid}`,
      runId,
      createdAt: rowid,
      textHash: `chat-${rowid}`,
      text: `message ${rowid}`,
    });
  }

  async total(): Promise<number> {
    return this.rows.length;
  }

  async newestRowid(): Promise<number> {
    return Math.max(0, ...this.rows.map((row) => row.rowid));
  }

  async before(rowid: number, limit: number): Promise<ChatSourceRow[]> {
    this.beforeCalls.push(rowid);
    return this.rows
      .filter((row) => row.rowid < rowid)
      .sort((a, b) => b.rowid - a.rowid)
      .slice(0, limit);
  }

  async after(rowid: number, limit: number): Promise<ChatSourceRow[]> {
    this.afterCalls.push(rowid);
    return this.rows
      .filter((row) => row.rowid > rowid)
      .sort((a, b) => a.rowid - b.rowid)
      .slice(0, limit);
  }

  async liveRunIds(): Promise<string[]> {
    return [...new Set(this.rows.map((row) => row.runId))];
  }
}

describe('EmbeddingIndexService', () => {
  let process: FakeEmbeddingProcess;
  let index: EmbeddingIndexService;
  let memory: FakeDocuments;
  let chats: FakeChats;

  beforeEach(() => {
    process = new FakeEmbeddingProcess(
      join(tempDir('embedding-index-'), 'embeddings.db'),
    );
    index = new EmbeddingIndexService(
      process as unknown as EmbeddingProcessService,
    );
    memory = new FakeDocuments('memory');
    chats = new FakeChats();
    index.registerDocuments(memory);
  });

  const waitReady = () =>
    vi.waitFor(async () => expect((await index.status()).state).toBe('ready'), {
      timeout: 3_000,
    });

  const indexedIds = (source: DocumentSource): string[] =>
    process.requests.flatMap((request) =>
      request.op === 'index' && request.source === source
        ? request.documents.map((document) => document.sourceId)
        : [],
    );

  const indexedChatIds = (): string[] =>
    process.requests.flatMap((request) =>
      request.op === 'indexChats'
        ? request.items.map((item) => item.itemId)
        : [],
    );

  describe('backfill and the queue', () => {
    it('asks the child which memories are missing and indexes only those', async () => {
      memory.set('m1', 'one');
      memory.set('m2', 'two');
      memory.set('m3', 'three');
      process.stored.memory.set('m1', 'hash-one');

      await index.setConfig(ON);
      await waitReady();

      expect(
        process.requests.find((request) => request.op === 'missing'),
      ).toEqual({
        op: 'missing',
        source: 'memory',
        slot: 'active',
        items: [
          { sourceId: 'm1', textHash: 'hash-one' },
          { sourceId: 'm2', textHash: 'hash-two' },
          { sourceId: 'm3', textHash: 'hash-three' },
        ],
      });
      expect(indexedIds('memory').sort()).toEqual(['m2', 'm3']);
      expect(process.stored.memory.size).toBe(3);
      expect(await index.status()).toMatchObject({
        state: 'ready',
        counts: { memory: { indexed: 3, total: 3 } },
      });
    });

    it('indexes an enqueued memory once its text reaches the child', async () => {
      await index.setConfig(ON);
      await waitReady();

      memory.set('m9', 'nine');
      index.enqueue('memory', ['m9']);
      await waitReady();

      expect(indexedIds('memory')).toEqual(['m9']);
      expect(process.stored.memory.get('m9')).toBe('hash-nine');
    });

    it('skips a memory whose text hash the child already holds', async () => {
      memory.set('m1', 'one');
      process.stored.memory.set('m1', 'hash-one');
      await index.setConfig(ON);
      await waitReady();
      const before = process.requests.length;

      index.enqueue('memory', ['m1']);
      await waitReady();

      const since = process.requests.slice(before);
      expect(since).toContainEqual(
        expect.objectContaining({
          op: 'missing',
          items: [{ sourceId: 'm1', textHash: 'hash-one' }],
        }),
      );
      expect(since.some((request) => request.op === 'index')).toBe(false);
    });

    it('deletes a memory the provider no longer has', async () => {
      process.stored.memory.set('gone', 'hash-x');
      await index.setConfig(ON);
      await waitReady();

      index.enqueue('memory', ['gone']);
      await waitReady();

      expect(process.requests).toContainEqual({
        op: 'delete',
        source: 'memory',
        sourceIds: ['gone'],
      });
      expect(process.stored.memory.has('gone')).toBe(false);
    });

    it('walks chats from the newest message down to the oldest, then reports them done', async () => {
      const total = CHAT_PAGE * 2 + 6;
      for (let rowid = 1; rowid <= total; rowid++) {
        chats.add(rowid, 'r1');
      }
      index.registerChats(chats);

      await index.setConfig(ON);
      await waitReady();

      const indexed = indexedChatIds();
      expect(indexed).toHaveLength(total);
      expect(new Set(indexed).size).toBe(total);
      expect(process.meta.get('chats:gemma@rev-1:fwd')).toBe(String(total));
      expect(process.meta.get('chats:gemma@rev-1:back')).toBe('0');
      expect(chats.beforeCalls[0]).toBe(total + 1);
      expect(await index.status()).toMatchObject({
        state: 'ready',
        counts: { chats: { indexed: total, total, paused: null } },
      });
    });

    it('indexes messages that arrive after the newest one through the forward cursor', async () => {
      chats.add(1, 'r1');
      chats.add(2, 'r1');
      index.registerChats(chats);
      await index.setConfig(ON);
      await waitReady();

      chats.add(3, 'r1');
      chats.add(4, 'r2');
      await index.setConfig(ON);
      await waitReady();

      expect(chats.afterCalls).toContain(2);
      expect(indexedChatIds()).toEqual(['c2', 'c1', 'c3', 'c4']);
      expect(process.meta.get('chats:gemma@rev-1:fwd')).toBe('4');
    });

    it('keeps chats waiting on battery while memories still index, and reports the pause', async () => {
      chats.add(1, 'r1');
      chats.add(2, 'r1');
      chats.add(3, 'r1');
      index.registerChats(chats);

      await index.setConfig({ ...ON, onBattery: true });
      memory.set('m5', 'five');
      index.enqueue('memory', ['m5']);

      await vi.waitFor(
        () => expect(process.stored.memory.has('m5')).toBe(true),
        {
          timeout: 3_000,
        },
      );
      expect(indexedChatIds()).toEqual([]);
      expect(chats.beforeCalls).toEqual([]);
      expect(chats.afterCalls).toEqual([]);
      expect((await index.status()).counts.chats).toMatchObject({
        indexed: 0,
        total: 3,
        paused: 'battery',
      });

      await index.setConfig(ON);
      await waitReady();

      expect(indexedChatIds()).toHaveLength(3);
      expect((await index.status()).counts.chats.paused).toBeNull();
    });

    it('reports the pending model complete only once its backfill has run', async () => {
      memory.set('m1', 'one');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      process.handlers.missing = async (request) => {
        if (request.slot === 'pending') {
          await gate;
        }
        return process.answer(request) as string[];
      };

      await index.setConfig({ ...ON, pendingModel: NEXT });
      await vi.waitFor(
        () =>
          expect(
            process.requests.some(
              (request) =>
                request.op === 'missing' && request.slot === 'pending',
            ),
          ).toBe(true),
        { timeout: 3_000 },
      );
      expect((await index.status()).pendingModel).toEqual({
        id: 'gemma',
        revision: 'rev-2',
        complete: false,
      });

      release();

      await vi.waitFor(
        async () =>
          expect((await index.status()).pendingModel?.complete).toBe(true),
        { timeout: 3_000 },
      );
    });

    it('sends the promote request when the new active model is the old pending one', async () => {
      await index.setConfig({ ...ON, pendingModel: NEXT });
      await index.setConfig({ ...ON, model: NEXT, pendingModel: null });

      expect(process.requests).toContainEqual({ op: 'promote' });
    });

    it('does not promote when the pending model is replaced by another', async () => {
      await index.setConfig({ ...ON, pendingModel: NEXT });
      await index.setConfig({ ...ON, pendingModel: THIRD });
      await index.setConfig({ ...ON, pendingModel: null });

      expect(process.requests.some((request) => request.op === 'promote')).toBe(
        false,
      );
    });
  });

  describe('queries fall back to words', () => {
    it('answers null and asks the child nothing while search by meaning is off', async () => {
      expect(await index.scoreDocuments('memory', 'query', null, 5)).toBeNull();
      expect(await index.searchChats('query', 10, null)).toBeNull();
      expect(process.requests).toEqual([]);
    });

    it("answers the child's scores while on, passing the ids and the limit through", async () => {
      process.handlers.score = () => [{ sourceId: 'm1', similarity: 0.9 }];
      await index.setConfig(ON);

      expect(
        await index.scoreDocuments('memory', 'query', ['m1', 'm2'], 5),
      ).toEqual([{ sourceId: 'm1', similarity: 0.9 }]);
      expect(process.requests).toContainEqual({
        op: 'score',
        source: 'memory',
        query: 'query',
        sourceIds: ['m1', 'm2'],
        limit: 5,
      });
    });

    it('answers null when the child times out or fails, so the caller keeps its word search', async () => {
      await index.setConfig(ON);
      process.handlers.score = () => {
        throw new EmbeddingUnavailableError('score took longer than 2000 ms');
      };
      process.handlers.searchChats = () => {
        throw new EmbeddingUnavailableError(
          'the embedding process exited with code 3',
        );
      };

      expect(await index.scoreDocuments('memory', 'query', null, 5)).toBeNull();
      expect(await index.searchChats('query', 10, null)).toBeNull();
    });

    it('answers null for an empty id list without asking the child', async () => {
      await index.setConfig(ON);
      await waitReady();
      const before = process.requests.length;

      expect(await index.scoreDocuments('memory', 'query', [], 5)).toBeNull();
      expect(await index.searchChats('query', 10, [])).toBeNull();
      expect(process.requests.slice(before)).toEqual([]);
    });

    it("passes the run ids of a scoped chat search through, and answers the child's hits", async () => {
      process.handlers.searchChats = () => [
        { itemId: 'i1', runId: 'r1', similarity: 0.8 },
      ];
      await index.setConfig(ON);

      expect(await index.searchChats('query', 20, ['r1'])).toEqual([
        { itemId: 'i1', runId: 'r1', similarity: 0.8 },
      ]);
      expect(process.requests).toContainEqual({
        op: 'searchChats',
        query: 'query',
        k: 20,
        runIds: ['r1'],
      });
    });
  });

  describe('deletions while the child is down', () => {
    const createDeletionsTable = () => {
      const raw = new DatabaseSync(process.dbPath);
      try {
        raw.exec(
          'CREATE TABLE deletions (source TEXT NOT NULL, source_id TEXT, run_id TEXT, queued_at INTEGER NOT NULL)',
        );
      } finally {
        raw.close();
      }
    };

    const queuedRows = (): unknown[] => {
      const raw = new DatabaseSync(process.dbPath);
      try {
        return raw
          .prepare(
            'SELECT source, source_id, run_id FROM deletions ORDER BY source, source_id, run_id',
          )
          .all();
      } finally {
        raw.close();
      }
    };

    it('queues the ids of a document deletion in the deletions table of the existing file', async () => {
      createDeletionsTable();
      process.alive = false;

      await index.deleteDocuments('memory', ['m1', 'm2']);

      expect(queuedRows()).toEqual([
        { source: 'memory', source_id: 'm1', run_id: null },
        { source: 'memory', source_id: 'm2', run_id: null },
      ]);
      expect(process.requests).toEqual([]);
    });

    it('queues a deleted run as a chats row', async () => {
      createDeletionsTable();
      process.alive = false;

      await index.deleteRuns(['r1']);

      expect(queuedRows()).toEqual([
        { source: 'chats', source_id: null, run_id: 'r1' },
      ]);
    });

    it('queues nothing and creates no file when the database does not exist yet', async () => {
      process.alive = false;

      await index.deleteDocuments('memory', ['m1']);

      expect(existsSync(process.dbPath)).toBe(false);
    });
  });

  describe('status and lifecycle', () => {
    it('reports off with no model, even when the switch is on', async () => {
      await index.setConfig({ ...ON, model: null });

      expect((await index.status()).state).toBe('off');
      expect(process.requests).toEqual([]);
    });

    it('reports failed while the child is down', async () => {
      await index.setConfig(ON);
      process.failure = 'the embedding process exited with code 3';

      expect(await index.status()).toMatchObject({
        state: 'failed',
        failure: 'the embedding process exited with code 3',
      });
    });

    it('stops the child when search by meaning is switched off', async () => {
      await index.setConfig(ON);
      await index.setConfig(DEFAULT_EMBEDDING_CONFIG);

      expect(process.stops).toBeGreaterThan(0);
      expect((await index.status()).state).toBe('off');
    });

    it("forgives the child's earlier failures on every config push", async () => {
      await index.setConfig(ON);
      await index.setConfig(ON);

      expect(process.forgiveCalls).toBe(2);
      expect(process.modelCalls.at(-1)).toEqual({
        active: MODEL,
        pending: null,
      });
    });
  });
});
