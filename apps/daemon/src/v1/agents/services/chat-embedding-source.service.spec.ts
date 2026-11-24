import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  type ChatSourceProvider,
  EMBEDDING_CHAT_COUNT_WINDOW,
} from '../../embeddings/embeddings.types';
import type { EmbeddingIndexService } from '../../embeddings/services/embedding-index.service';
import type { ItemWire } from '../chat.types';
import type {
  ChatEmbeddableRow,
  ChatSearchIndexDao,
} from '../dao/chat-search-index.dao';
import type * as eventLoopSlicesModule from '../utils/event-loop-slices';
import { AgentEventBus } from './agent-events.bus';
import { ChatEmbeddingSourceService } from './chat-embedding-source.service';

const { yieldIfHeld } = vi.hoisted(() => ({
  yieldIfHeld: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('../utils/event-loop-slices', async (importOriginal) => ({
  ...(await importOriginal<typeof eventLoopSlicesModule>()),
  eventLoopSlicer: () => yieldIfHeld,
}));

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
    embeddableCountBetween: vi.fn<
      (after: number, upTo: number) => Promise<number>
    >(async () => 0),
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
    chatAdded: vi.fn<() => void>(),
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

function stored(kind: ItemWire['kind'], role: ItemWire['role']): ItemWire {
  return {
    id: `i-${kind}-${role}`,
    runId: 'r1',
    memberId: null,
    seq: 1,
    kind,
    role,
    payload: { text: 'The nightly backup lands in the wrong bucket.' },
    createdAt: new Date(0).toISOString(),
  };
}

describe('ChatEmbeddingSourceService', () => {
  it('tells the index each time a user or assistant message is stored, and only then', () => {
    const { bus, embeddings } = setup();

    bus.publish({ runId: 'r1', item: stored('message', 'user') });
    bus.publish({ runId: 'r1', item: stored('message', 'assistant') });
    bus.publish({ runId: 'r1', item: stored('reasoning', 'assistant') });
    bus.publish({ runId: 'r1', item: stored('tool_call', 'assistant') });

    expect(embeddings.chatAdded).toHaveBeenCalledTimes(2);
  });

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

  it('reads its cursor and live runs from the dao', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);
    dao.newestItemRowid.mockResolvedValueOnce(12);
    dao.liveRunIds.mockResolvedValueOnce(['r1', 'r2']);

    expect(await provider.newestRowid()).toBe(12);
    expect(await provider.liveRunIds()).toEqual(['r1', 'r2']);
  });

  it('counts the total window by window of item rowids, up to the newest one', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);
    const newest = EMBEDDING_CHAT_COUNT_WINDOW * 2 + 7;
    dao.newestItemRowid.mockResolvedValueOnce(newest);
    dao.embeddableCountBetween
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    expect(await provider.total()).toBe(12);
    expect(dao.embeddableCountBetween.mock.calls).toEqual([
      [0, EMBEDDING_CHAT_COUNT_WINDOW],
      [EMBEDDING_CHAT_COUNT_WINDOW, EMBEDDING_CHAT_COUNT_WINDOW * 2],
      [EMBEDDING_CHAT_COUNT_WINDOW * 2, newest],
    ]);
  });

  it('offers the event loop a turn before each window it counts', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);
    dao.newestItemRowid.mockResolvedValueOnce(EMBEDDING_CHAT_COUNT_WINDOW * 2);
    yieldIfHeld.mockClear();

    await provider.total();

    const yields = yieldIfHeld.mock.invocationCallOrder;
    const counts = dao.embeddableCountBetween.mock.invocationCallOrder;
    expect(yields).toHaveLength(2);
    expect(counts).toHaveLength(2);
    expect(yields[0]!).toBeLessThan(counts[0]!);
    expect(yields[1]!).toBeGreaterThan(counts[0]!);
    expect(yields[1]!).toBeLessThan(counts[1]!);
  });

  it('counts nothing when there are no items', async () => {
    const { dao, embeddings } = setup();
    const provider = registeredProvider(embeddings);

    expect(await provider.total()).toBe(0);
    expect(dao.embeddableCountBetween).not.toHaveBeenCalled();
  });
});
