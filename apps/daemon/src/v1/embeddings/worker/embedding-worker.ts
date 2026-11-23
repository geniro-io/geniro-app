import { setPriority } from 'node:os';

import {
  EMBEDDING_CHAT_CHUNK_TOKENS,
  EMBEDDING_MAX_TOKENS,
  type EmbeddingModelRef,
  type ModelSlot,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResults,
} from '../embeddings.types';
import { chunkText, Embedder } from './embedder';
import { EmbeddingStore, modelKey } from './embedding-store';

const LOWEST_PRIORITY = 19;

/**
 * The embedding child: holds the model sessions and `embeddings.db`, and
 * answers the daemon's requests over the IPC channel. Nothing here may run in
 * the daemon process: a native crash in onnxruntime ends only this process.
 */
class EmbeddingWorker {
  private store: EmbeddingStore | null = null;
  private refs: Record<ModelSlot, EmbeddingModelRef | null> = {
    active: null,
    pending: null,
  };
  private readonly loaded = new Map<string, Promise<Embedder>>();

  async handle(request: WorkerRequest): Promise<unknown> {
    switch (request.op) {
      case 'open':
        this.store?.close();
        this.store = await EmbeddingStore.open(request.dbPath);
        return {
          indexBytes: this.store.indexBytes(),
        } satisfies WorkerResults['open'];
      case 'models':
        this.refs = { active: request.active, pending: request.pending };
        await this.releaseExcept(
          [request.active, request.pending].flatMap((ref) =>
            ref ? [modelKey(ref)] : [],
          ),
        );
        return null;
      case 'unload':
        await this.releaseExcept([]);
        return null;
      case 'missing':
        return this.openStore().missingDocuments(
          request.source,
          this.keyOf(request.slot),
          request.items,
        );
      case 'index': {
        const embedder = await this.embedder(request.slot);
        const pieces = request.documents.map((document) =>
          document.chunks.flatMap((chunk) =>
            chunkText(chunk, EMBEDDING_MAX_TOKENS, (text) =>
              embedder.tokenCount(text),
            ),
          ),
        );
        const vectors = await embedder.embed(pieces.flat(), 'document');
        let next = 0;
        const stored = await this.openStore().storeDocuments(
          request.source,
          modelKey(embedder.model),
          request.documents.map((document, i) => {
            const count = pieces[i]?.length ?? 0;
            const own = vectors.slice(next, next + count);
            next += count;
            return {
              sourceId: document.sourceId,
              textHash: document.textHash,
              vectors: own,
            };
          }),
        );
        return { stored } satisfies WorkerResults['index'];
      }
      case 'indexChats': {
        const embedder = await this.embedder(request.slot);
        const key = modelKey(embedder.model);
        const store = this.openStore();
        const missing = new Set(
          await store.missingChatItems(key, request.items),
        );
        const todo = request.items.filter((item) => missing.has(item.itemId));
        const pieces = todo.map((item) =>
          chunkText(item.text, EMBEDDING_CHAT_CHUNK_TOKENS, (text) =>
            embedder.tokenCount(text),
          ),
        );
        const vectors = await embedder.embed(pieces.flat(), 'document');
        let next = 0;
        const stored = await store.storeChatItems(
          key,
          todo.map((item, i) => {
            const count = pieces[i]?.length ?? 0;
            const own = vectors.slice(next, next + count);
            next += count;
            return { ...item, vectors: own };
          }),
        );
        return { stored } satisfies WorkerResults['indexChats'];
      }
      case 'score': {
        const embedder = await this.embedder('active');
        const [query] = await embedder.embed([request.query], 'query');
        return this.openStore().scoreDocuments(
          request.source,
          modelKey(embedder.model),
          query as Float32Array,
          request.sourceIds,
          request.limit,
        );
      }
      case 'searchChats': {
        const embedder = await this.embedder('active');
        const [query] = await embedder.embed([request.query], 'query');
        return this.openStore().searchChats(
          modelKey(embedder.model),
          query as Float32Array,
          request.k,
          request.runIds,
        );
      }
      case 'delete':
        return {
          deleted: await this.openStore().deleteDocuments(
            request.source,
            request.sourceIds,
          ),
        } satisfies WorkerResults['delete'];
      case 'deleteRuns':
        return {
          deleted: await this.openStore().deleteRuns(request.runIds),
        } satisfies WorkerResults['deleteRuns'];
      case 'keepRuns':
        return {
          deleted: await this.openStore().keepRuns(request.runIds),
        } satisfies WorkerResults['keepRuns'];
      case 'counts': {
        const store = this.openStore();
        return {
          ...(await store.counts(this.keyOf(request.slot))),
          indexBytes: store.indexBytes(),
        } satisfies WorkerResults['counts'];
      }
      case 'getMeta':
        return this.openStore().getMeta(request.key);
      case 'setMeta':
        await this.openStore().setMeta(request.key, request.value);
        return null;
      case 'promote':
        await this.openStore().keepOnlyModel(this.keyOf('active'));
        return null;
      case 'clear':
        await this.openStore().clear();
        return null;
    }
  }

  async close(): Promise<void> {
    await this.releaseExcept([]);
    this.store?.close();
    this.store = null;
  }

  private openStore(): EmbeddingStore {
    if (!this.store) {
      throw new Error('embeddings.db is not open');
    }
    return this.store;
  }

  private keyOf(slot: ModelSlot): string {
    const ref = this.refs[slot];
    if (!ref) {
      throw new Error(`no ${slot} model`);
    }
    return modelKey(ref);
  }

  private embedder(slot: ModelSlot): Promise<Embedder> {
    const ref = this.refs[slot];
    if (!ref) {
      return Promise.reject(new Error(`no ${slot} model`));
    }
    const key = modelKey(ref);
    let loading = this.loaded.get(key);
    if (!loading) {
      loading = Embedder.load(ref);
      this.loaded.set(key, loading);
      loading.catch(() => this.loaded.delete(key));
    }
    return loading;
  }

  private async releaseExcept(keep: readonly string[]): Promise<void> {
    for (const [key, loading] of [...this.loaded]) {
      if (keep.includes(key)) {
        continue;
      }
      this.loaded.delete(key);
      await loading
        .then((embedder) => embedder.release())
        .catch(() => undefined);
    }
  }
}

function isRequest(value: unknown): value is { id: number } & WorkerRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number' &&
    typeof (value as { op?: unknown }).op === 'string'
  );
}

function reply(message: WorkerMessage): void {
  process.send?.(message);
}

function main(): void {
  if (!process.send) {
    process.stderr.write(
      'the embedding worker runs only as a child with an IPC channel\n',
    );
    process.exit(1);
  }
  try {
    setPriority(LOWEST_PRIORITY);
  } catch {
    // A lower priority is a courtesy; the work runs without it.
  }
  const worker = new EmbeddingWorker();
  process.on('message', (message: unknown) => {
    if (!isRequest(message)) {
      return;
    }
    const { id, ...request } = message;
    worker.handle(request as WorkerRequest).then(
      (result) => reply({ id, ok: true, result }),
      (err: unknown) =>
        reply({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  });
  process.on('disconnect', () => {
    void worker.close().finally(() => process.exit(0));
  });
}

main();
