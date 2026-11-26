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
  EMBEDDING_SWEEP_INTERVAL_MS,
  EMBEDDING_TOTALS_FRESH_MS,
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
  sources: { memory: true, knowledge: true, chats: true },
  chatWindowDays: null,
};
const DAY_MS = 24 * 60 * 60_000;
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
  readonly chatCreated = new Map<string, number>();
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

  crash(restartInMs: number): void {
    this.events.next({ kind: 'crashed', reason: 'killed', restartInMs });
  }

  async request<Op extends WorkerOp>(
    request: WorkerRequestOf<Op>,
    _timeoutMs: number,
  ): Promise<WorkerResults[Op]> {
    this.requests.push(request);
    const override = this.handlers[request.op];
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
          this.chatCreated.set(item.itemId, item.createdAt);
        }
        return { stored: request.items.length };
      case 'dropSource': {
        if (request.source !== 'chats') {
          const deleted = this.stored[request.source].size;
          this.stored[request.source].clear();
          return { deleted };
        }
        const deleted = this.chats.size;
        this.chats.clear();
        this.chatCreated.clear();
        for (const key of [...this.meta.keys()]) {
          if (key.startsWith('chats:')) {
            this.meta.delete(key);
          }
        }
        return { deleted };
      }
      case 'deleteChatsBefore': {
        let deleted = 0;
        for (const [itemId, createdAt] of [...this.chatCreated]) {
          if (createdAt < request.createdBefore) {
            this.chats.delete(itemId);
            this.chatCreated.delete(itemId);
            deleted += 1;
          }
        }
        return { deleted };
      }
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
  totalCalls = 0;
  totalGate: Promise<void> | null = null;

  add(
    rowid: number,
    runId: string,
    itemId = `c${rowid}`,
    createdAt = rowid,
  ): void {
    this.rows.push({
      rowid,
      itemId,
      runId,
      createdAt,
      textHash: `chat-${itemId}`,
      text: `message ${itemId}`,
    });
  }

  removeRun(runId: string): void {
    const kept = this.rows.filter((row) => row.runId !== runId);
    this.rows.splice(0, this.rows.length, ...kept);
  }

  async total(createdAfter: number | null): Promise<number> {
    this.totalCalls++;
    await this.totalGate;
    return this.rows.filter(
      (row) => createdAfter === null || row.createdAt >= createdAfter,
    ).length;
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

  /** A status read as it is answered once `ms` have passed on the wall clock. */
  async function statusAfter(ms: number) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms });
    try {
      return await index.status();
    } finally {
      vi.useRealTimers();
    }
  }

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

    it('indexes messages that reuse the rowids of a deleted newest chat', async () => {
      chats.add(1, 'old');
      chats.add(2, 'old');
      chats.add(3, 'newest');
      chats.add(4, 'newest');
      index.registerChats(chats);
      await index.setConfig(ON);
      await waitReady();

      chats.removeRun('newest');
      await index.deleteRuns(['newest']);
      chats.add(3, 'old', 'reply-1');
      chats.add(4, 'old', 'reply-2');
      await index.setConfig(ON);
      await waitReady();

      expect(indexedChatIds()).toEqual(
        expect.arrayContaining(['reply-1', 'reply-2']),
      );
      expect(process.meta.get('chats:gemma@rev-1:fwd')).toBe('4');
    });

    it('steps back a stored forward cursor that is past the newest message, so the messages below it are indexed', async () => {
      process.meta.set('chats:gemma@rev-1:fwd', '82');
      process.meta.set('chats:gemma@rev-1:back', '0');
      chats.add(70, 'r1', 'late-1');
      chats.add(71, 'r1', 'late-2');
      index.registerChats(chats);

      await index.setConfig(ON);
      await waitReady();

      expect(indexedChatIds()).toEqual(['late-1', 'late-2']);
      expect(process.meta.get('chats:gemma@rev-1:fwd')).toBe('71');
    });

    it('steps the stored cursor back in the file when a chat is deleted while the child is down', async () => {
      const raw = new DatabaseSync(process.dbPath);
      raw.exec(
        'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE deletions (source TEXT NOT NULL, source_id TEXT, run_id TEXT, queued_at INTEGER NOT NULL);',
      );
      raw
        .prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('chats:gemma@rev-1:fwd', '82');
      raw.close();
      chats.add(40, 'r1');
      index.registerChats(chats);
      await index.setConfig({ ...ON, enabled: false });
      process.alive = false;

      await index.deleteRuns(['gone']);

      const check = new DatabaseSync(process.dbPath);
      try {
        expect(
          check
            .prepare('SELECT value FROM meta WHERE key = ?')
            .get('chats:gemma@rev-1:fwd'),
        ).toEqual({ value: '8' });
      } finally {
        check.close();
      }
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

    it('tells readers a stored chat message moved the totals only while chats wait for power', async () => {
      chats.add(1, 'r1');
      index.registerChats(chats);
      const reasons: string[] = [];
      index.changes().subscribe((event) => reasons.push(event.reason));

      await index.setConfig(ON);
      await waitReady();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      reasons.length = 0;
      index.chatAdded();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      expect(reasons).toEqual([]);

      await index.setConfig({ ...ON, onBattery: true });
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      reasons.length = 0;
      chats.add(2, 'r1');
      index.chatAdded();
      await vi.waitFor(() => expect(reasons).toEqual(['progress']), {
        timeout: 3_000,
      });
      expect(
        (await statusAfter(EMBEDDING_TOTALS_FRESH_MS)).counts.chats,
      ).toMatchObject({ indexed: 1, total: 2, paused: 'battery' });

      await index.setConfig({ ...ON, enabled: false, onBattery: true });
      reasons.length = 0;
      index.chatAdded();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      expect(reasons).toEqual([]);
    }, 15_000);

    it('counts the totals once per freshness window, however many messages are stored meanwhile', async () => {
      chats.add(1, 'r1');
      index.registerChats(chats);
      await index.setConfig(ON);
      await waitReady();
      const counted = chats.totalCalls;

      chats.add(2, 'r1');
      index.chatAdded();
      index.chatAdded();
      const status = await index.status();

      expect(chats.totalCalls).toBe(counted);
      expect(status.counts.chats.total).toBe(1);
      expect(
        (await statusAfter(EMBEDDING_TOTALS_FRESH_MS)).counts.chats.total,
      ).toBe(2);
      expect(chats.totalCalls).toBe(counted + 1);
    });

    it('shares one count between status reads that arrive while it runs', async () => {
      chats.add(1, 'r1');
      chats.add(2, 'r1');
      index.registerChats(chats);
      let release: () => void = () => undefined;
      chats.totalGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await index.setConfig({ ...ON, onBattery: true });

      const first = index.status();
      const second = index.status();
      release();
      const [one, two] = await Promise.all([first, second]);

      expect(chats.totalCalls).toBe(1);
      expect(one.counts.chats.total).toBe(2);
      expect(two.counts.chats.total).toBe(2);
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

    it('turns the index off and on again by backfilling from scratch, so a change made while it was off is indexed', async () => {
      memory.set('m1', 'one');
      await index.setConfig(ON);
      await waitReady();
      await index.setConfig({ ...ON, enabled: false });

      memory.set('m1', 'one-edited');
      memory.set('m2', 'two');
      const before = process.requests.length;
      await index.setConfig(ON);
      await waitReady();

      expect(process.requests.slice(before)).toContainEqual({
        op: 'missing',
        source: 'memory',
        slot: 'active',
        items: [
          { sourceId: 'm1', textHash: 'hash-one-edited' },
          { sourceId: 'm2', textHash: 'hash-two' },
        ],
      });
      expect(process.stored.memory.get('m1')).toBe('hash-one-edited');
      expect(process.stored.memory.get('m2')).toBe('hash-two');
    });

    it('indexes a memory again when it is enqueued while its batch is in flight and its text has changed', async () => {
      memory.set('m1', 'one');
      let reachIndex!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachIndex = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let batches = 0;
      process.handlers.index = async (request) => {
        batches += 1;
        if (batches === 1) {
          reachIndex();
          await gate;
        }
        for (const document of request.documents) {
          process.stored.memory.set(document.sourceId, document.textHash);
        }
        return { stored: request.documents.length };
      };

      await index.setConfig(ON);
      await reached;
      memory.set('m1', 'one-edited');
      index.enqueue('memory', ['m1']);
      release();
      await waitReady();

      expect(indexedIds('memory')).toEqual(['m1', 'm1']);
      expect(process.stored.memory.get('m1')).toBe('hash-one-edited');
    });

    it('puts a batch back in the queue when the provider fails, so the next kick indexes it', async () => {
      memory.set('m1', 'one');
      memory.set('m2', 'two');
      const documents = vi
        .spyOn(memory, 'documents')
        .mockRejectedValueOnce(new Error('database is locked'));

      await index.setConfig(ON);
      await vi.waitFor(() => expect(documents).toHaveBeenCalledOnce());
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(indexedIds('memory')).toEqual([]);

      memory.set('m3', 'three');
      index.enqueue('memory', ['m3']);
      await waitReady();

      expect(indexedIds('memory').sort()).toEqual(['m1', 'm2', 'm3']);
      expect(process.stored.memory.size).toBe(3);
    });

    it('sweeps the vectors of deleted chats once a day, keeping the runs its chat provider still lists', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        chats.add(1, 'run-a');
        chats.add(2, 'run-b');
        chats.add(3, 'run-a');
        index.registerChats(chats);
        await index.setConfig(ON);

        await vi.advanceTimersByTimeAsync(EMBEDDING_SWEEP_INTERVAL_MS);

        expect(process.requests).toContainEqual({
          op: 'keepRuns',
          runIds: ['run-a', 'run-b'],
        });
      } finally {
        index.onApplicationShutdown();
        vi.useRealTimers();
      }
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

    it('carries on with the batch a crash cut short once the child may start again', async () => {
      memory.set('m1', 'one');
      let crashes = 1;
      process.handlers.index = (request) => {
        if (crashes > 0) {
          crashes -= 1;
          throw new EmbeddingUnavailableError('the embedding process exited');
        }
        return process.answer(request) as WorkerResults['index'];
      };
      await index.setConfig(ON);
      await vi.waitFor(() => expect(crashes).toBe(0), { timeout: 3_000 });
      expect(process.stored.memory.has('m1')).toBe(false);

      process.crash(10);

      await vi.waitFor(
        () => expect(process.stored.memory.get('m1')).toBe('hash-one'),
        { timeout: 3_000 },
      );
    });

    it('keeps the counts it last read while switching on again re-checks the index', async () => {
      memory.set('m1', 'one');
      memory.set('m2', 'two');
      await index.setConfig(ON);
      await waitReady();
      await index.setConfig({ ...ON, enabled: false });

      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      process.handlers.counts = async (request) => {
        await gate;
        return process.answer(request) as WorkerResults['counts'];
      };
      await index.setConfig(ON);

      expect((await index.status()).counts.memory).toEqual({
        indexed: 2,
        total: 2,
      });
      release();
      await waitReady();
    });

    it('reads the stored counts before any other work after a start', async () => {
      process.stored.memory.set('m1', 'hash-one');
      memory.set('m1', 'one');

      await index.setConfig(ON);
      await waitReady();

      expect(process.requests.find((request) => request.op !== 'open')).toEqual(
        { op: 'counts', slot: 'active' },
      );
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

  describe('sources and the chat window', () => {
    let knowledge: FakeDocuments;

    beforeEach(() => {
      knowledge = new FakeDocuments('knowledge');
      index.registerDocuments(knowledge);
    });

    it('embeds nothing of a source switched off, drops its vectors and leaves its searches to words', async () => {
      memory.set('m1', 'one');
      knowledge.set('k1', 'doc');
      process.stored.memory.set('old', 'hash-old');

      await index.setConfig({
        ...ON,
        sources: { memory: false, knowledge: true, chats: true },
      });
      await waitReady();
      memory.set('m2', 'two');
      index.enqueue('memory', ['m2']);
      await waitReady();

      expect(indexedIds('memory')).toEqual([]);
      expect(indexedIds('knowledge')).toEqual(['k1']);
      expect(process.requests).toContainEqual({
        op: 'dropSource',
        source: 'memory',
      });
      expect(process.stored.memory.size).toBe(0);
      expect(
        process.requests.some(
          (request) => request.op === 'missing' && request.source === 'memory',
        ),
      ).toBe(false);
      const asked = process.requests.length;
      expect(await index.scoreDocuments('memory', 'q', null, 5)).toBeNull();
      expect(process.requests.length).toBe(asked);
      expect((await index.status()).counts.memory).toEqual({
        indexed: 0,
        total: 0,
      });
    });

    it('backfills a source again once it is switched back on', async () => {
      memory.set('m1', 'one');
      await index.setConfig({
        ...ON,
        sources: { memory: false, knowledge: true, chats: true },
      });
      await waitReady();

      await index.setConfig(ON);
      await waitReady();

      expect(indexedIds('memory')).toEqual(['m1']);
      expect(
        (await statusAfter(EMBEDDING_TOTALS_FRESH_MS)).counts.memory,
      ).toEqual({
        indexed: 1,
        total: 1,
      });
    });

    it('walks no chats while chats are off, drops their vectors and cursors, and walks them anew when switched back on', async () => {
      chats.add(1, 'r1');
      chats.add(2, 'r1');
      index.registerChats(chats);
      await index.setConfig(ON);
      await waitReady();
      expect(indexedChatIds()).toEqual(['c2', 'c1']);

      await index.setConfig({
        ...ON,
        sources: { memory: true, knowledge: true, chats: false },
      });
      await waitReady();
      expect(process.chats.size).toBe(0);
      expect(process.meta.get('chats:gemma@rev-1:fwd')).toBeUndefined();
      expect(await index.searchChats('q', 5, null)).toBeNull();
      expect(await index.status()).toMatchObject({
        state: 'ready',
        counts: { chats: { indexed: 0, total: 0, paused: null } },
      });

      const before = indexedChatIds().length;
      await index.setConfig(ON);
      await waitReady();

      expect(indexedChatIds().slice(before)).toEqual(['c2', 'c1']);
      expect(process.chats.size).toBe(2);
    });

    it('embeds only chats inside the window and drops the vectors of older ones', async () => {
      const now = Date.now();
      chats.add(1, 'r1', 'old-1', now - 40 * DAY_MS);
      chats.add(2, 'r1', 'old-2', now - 31 * DAY_MS);
      chats.add(3, 'r2', 'new-1', now - 10 * DAY_MS);
      chats.add(4, 'r2', 'new-2', now - DAY_MS);
      process.chats.set('ancient', 'hash');
      process.chatCreated.set('ancient', now - 400 * DAY_MS);
      index.registerChats(chats);

      await index.setConfig({ ...ON, chatWindowDays: 30 });
      await waitReady();

      expect(indexedChatIds()).toEqual(['new-2', 'new-1']);
      expect(process.chats.has('ancient')).toBe(false);
      const trim = process.requests.find(
        (request) => request.op === 'deleteChatsBefore',
      );
      expect(trim).toBeDefined();
      if (trim?.op === 'deleteChatsBefore') {
        expect(Math.abs(trim.createdBefore - (now - 30 * DAY_MS))).toBeLessThan(
          60_000,
        );
      }
      expect(await index.status()).toMatchObject({
        state: 'ready',
        counts: { chats: { indexed: 2, total: 2 } },
      });
      expect(process.meta.get('chat_window_days')).toBe('30');
    });

    it('drops chats that fall out of the window as days pass, on the daily sweep', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
      try {
        const now = Date.now();
        chats.add(1, 'r1', 'aging', now - 29 * DAY_MS);
        index.registerChats(chats);
        await index.setConfig({ ...ON, chatWindowDays: 30 });
        await vi.waitFor(() => expect(process.chats.has('aging')).toBe(true));

        await vi.advanceTimersByTimeAsync(EMBEDDING_SWEEP_INTERVAL_MS * 2);

        await vi.waitFor(() => expect(process.chats.has('aging')).toBe(false));
      } finally {
        vi.useRealTimers();
      }
    });

    it('walks the chats again when the window widens, so the messages it now takes in are embedded', async () => {
      const now = Date.now();
      chats.add(1, 'r1', 'old', now - 60 * DAY_MS);
      chats.add(2, 'r1', 'mid', now - 20 * DAY_MS);
      chats.add(3, 'r1', 'new', now - DAY_MS);
      index.registerChats(chats);
      await index.setConfig({ ...ON, chatWindowDays: 7 });
      await waitReady();
      expect(indexedChatIds()).toEqual(['new']);

      await index.setConfig({ ...ON, chatWindowDays: 30 });
      await waitReady();
      expect([...process.chats.keys()].sort()).toEqual(['mid', 'new']);

      await index.setConfig({ ...ON, chatWindowDays: null });
      await waitReady();
      expect([...process.chats.keys()].sort()).toEqual(['mid', 'new', 'old']);
      expect(process.meta.get('chat_window_days')).toBe('all');
    });

    it('walks the chats again for a window wider than the stored one after a restart', async () => {
      const now = Date.now();
      chats.add(1, 'r1', 'old', now - 60 * DAY_MS);
      chats.add(2, 'r1', 'new', now - DAY_MS);
      process.meta.set('chat_window_days', '7');
      process.meta.set('chats:gemma@rev-1:fwd', '2');
      process.meta.set('chats:gemma@rev-1:back', '0');
      process.chats.set('new', 'chat-new');
      process.chatCreated.set('new', now - DAY_MS);
      index.registerChats(chats);

      await index.setConfig(ON);
      await waitReady();

      expect(process.chats.has('old')).toBe(true);
    });

    it('says which source search by meaning leaves to words, and nothing while it is off or covers all', async () => {
      expect(index.meaningNote('memory')).toBeNull();

      await index.setConfig(ON);
      expect(index.meaningNote('memory')).toBeNull();
      expect(index.meaningNote('chats')).toBeNull();

      await index.setConfig({
        ...ON,
        sources: { memory: true, knowledge: false, chats: true },
        chatWindowDays: 30,
      });
      expect(index.meaningNote('knowledge')).toBe(
        'Search by meaning is off for knowledge documents in Settings → Search, so only word matches are listed.',
      );
      expect(index.meaningNote('chats')).toBe(
        'Search by meaning covers only chats from the last 30 days; older messages are found by their words alone.',
      );
      expect(index.meaningNote('memory')).toBeNull();

      await index.setConfig({
        ...ON,
        enabled: false,
        sources: { memory: false, knowledge: false, chats: false },
      });
      expect(index.meaningNote('memory')).toBeNull();
    });
  });
});
