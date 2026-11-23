import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { ChatSourceProvider } from '../../embeddings/embeddings.types';
import type { EmbeddingIndexService } from '../../embeddings/services/embedding-index.service';
import type {
  ChatEmbeddableRow,
  ChatSearchIndexDao,
} from '../dao/chat-search-index.dao';
import { AgentEventBus } from './agent-events.bus';
import { ChatEmbeddingSourceService } from './chat-embedding-source.service';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function row(
  rowid: number,
  id: string,
  runId: string,
  text: string,
): ChatEmbeddableRow {
  return { rowid, id, run_id: runId, created_at: rowid * 10, text };
}

function setup() {
  const bus = new AgentEventBus();
  const dao = {
    embeddableCount: vi.fn<() => Promise<number>>(async () => 0),
    newestItemRowid: vi.fn<() => Promise<number>>(async () => 0),
    embeddableRows: vi.fn<
      (
        from: number,
        direction: 'before' | 'after',
        limit: number,
      ) => Promise<ChatEmbeddableRow[]>
    >(async () => []),
    liveRunIds: vi.fn<() => Promise<string[]>>(async () => []),
  };
  const embeddings = {
    registerChats: vi.fn<(provider: ChatSourceProvider) => void>(),
    deleteRuns: vi.fn<(runIds: readonly string[]) => Promise<void>>(
      async () => undefined,
    ),
  };
  const service = new ChatEmbeddingSourceService(
    dao as unknown as ChatSearchIndexDao,
    bus,
    embeddings as unknown as EmbeddingIndexService,
  );
  service.onModuleInit();
  return { bus, dao, embeddings };
}

function registeredProvider(
  embeddings: ReturnType<typeof setup>['embeddings'],
): ChatSourceProvider {
  const provider = embeddings.registerChats.mock.calls[0]?.[0];
  if (!provider) {
    throw new Error('the chat source was never registered');
  }
  return provider;
}

describe('ChatEmbeddingSourceService', () => {
  it('asks the index to drop the vectors of a deleted run', () => {
    const { bus, embeddings } = setup();

    bus.publishRunDeleted('r1');

    expect(embeddings.deleteRuns).toHaveBeenCalledOnce();
    expect(embeddings.deleteRuns).toHaveBeenCalledWith(['r1']);
  });

  it('registers the chat history once, with rows that carry the hash of their text', async () => {
    const { dao, embeddings } = setup();
    expect(embeddings.registerChats).toHaveBeenCalledOnce();
    const provider = registeredProvider(embeddings);
    dao.embeddableRows.mockResolvedValueOnce([
      row(9, 'i9', 'r2', 'newest text'),
      row(8, 'i8', 'r1', 'older'),
    ]);

    expect(await provider.before(10, 2)).toEqual([
      {
        rowid: 9,
        itemId: 'i9',
        runId: 'r2',
        createdAt: 90,
        textHash: sha256('newest text'),
        text: 'newest text',
      },
      {
        rowid: 8,
        itemId: 'i8',
        runId: 'r1',
        createdAt: 80,
        textHash: sha256('older'),
        text: 'older',
      },
    ]);
    expect(dao.embeddableRows).toHaveBeenLastCalledWith(10, 'before', 2);
  });

  it('maps the rows above a cursor the same way', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);
    dao.embeddableRows.mockResolvedValueOnce([row(11, 'i11', 'r3', 'later')]);

    expect(await provider.after(10, 5)).toEqual([
      {
        rowid: 11,
        itemId: 'i11',
        runId: 'r3',
        createdAt: 110,
        textHash: sha256('later'),
        text: 'later',
      },
    ]);
    expect(dao.embeddableRows).toHaveBeenLastCalledWith(10, 'after', 5);
  });

  it('reads its totals, cursor and live runs from the dao', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);
    dao.embeddableCount.mockResolvedValueOnce(4);
    dao.newestItemRowid.mockResolvedValueOnce(12);
    dao.liveRunIds.mockResolvedValueOnce(['r1', 'r2']);

    expect(await provider.total()).toBe(4);
    expect(await provider.newestRowid()).toBe(12);
    expect(await provider.liveRunIds()).toEqual(['r1', 'r2']);
  });
});
