import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import { EmbeddingStore, type StoredChatItem } from './embedding-store';

const DIM = 768;
const MODEL = 'model-a@rev-1';
const OTHER = 'model-b@rev-2';
const CORPUS_RUNS = 40;
const CORPUS_ITEMS_PER_RUN = 50;
const LATENCY_BOUND_MS = 500;

/** A deterministic unit vector: the same seed stores the same numbers on every run. */
function unit(seed: number): Float32Array {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const raw = Float32Array.from({ length: DIM }, () => next() * 2 - 1);
  return normalized(raw);
}

function normalized(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  return Float32Array.from(vector, (value) => value / norm);
}

/** `base` pulled `noise` of the way toward `other`: cosine to `base` is 1 / sqrt(1 + noise²). */
function near(base: Float32Array, other: Float32Array, noise: number) {
  return normalized(
    Float32Array.from(base, (value, i) => value + noise * (other[i] ?? 0)),
  );
}

function chatItem(itemId: string, runId: string, seed: number): StoredChatItem {
  return {
    itemId,
    runId,
    createdAt: seed,
    textHash: `hash-${itemId}`,
    vectors: [unit(seed)],
  };
}

function runName(run: number): string {
  return `run-${String(run).padStart(2, '0')}`;
}

/** 40 runs of 50 messages, one chunk each: 2 000 chunks in all. */
async function storeCorpus(store: EmbeddingStore): Promise<void> {
  for (let run = 0; run < CORPUS_RUNS; run++) {
    const items: StoredChatItem[] = [];
    for (let i = 0; i < CORPUS_ITEMS_PER_RUN; i++) {
      const index = run * CORPUS_ITEMS_PER_RUN + i;
      items.push(chatItem(`item-${index}`, runName(run), 1000 + index));
    }
    await store.storeChatItems(MODEL, items);
  }
}

function manyDocuments(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    sourceId: `doc-${i}`,
    textHash: `hash-${i}`,
    vectors: [unit(i + 1)],
  }));
}

/** The file's bytes on disk after its WAL is folded in, so a size comparison is fair. */
function checkpointedSize(path: string): number {
  const raw = new DatabaseSync(path);
  try {
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    raw.close();
  }
  return statSync(path).size;
}

function freelistPages(path: string): number {
  const raw = new DatabaseSync(path);
  try {
    const row = raw.prepare('PRAGMA freelist_count').get() as {
      freelist_count: number;
    };
    return row.freelist_count;
  } finally {
    raw.close();
  }
}

describe('EmbeddingStore', () => {
  let path: string;
  let store: EmbeddingStore;

  beforeEach(async () => {
    path = join(tempDir('embeddings-store-'), 'embeddings.db');
    store = await EmbeddingStore.open(path);
  });

  afterEach(() => {
    store.close();
  });

  describe('documents (memory and knowledge)', () => {
    it('scores a query against the best chunk of each named document and drops weak matches', async () => {
      const target = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h1', vectors: [unit(10)] },
        { sourceId: 'm2', textHash: 'h2', vectors: [unit(2), target] },
      ]);

      const hits = await store.scoreDocuments(
        'memory',
        MODEL,
        target,
        null,
        10,
      );

      expect(hits.map((hit) => hit.sourceId)).toEqual(['m2']);
      expect(hits[0]?.similarity).toBeCloseTo(1, 5);
    });

    it('scores only the documents whose ids it is given', async () => {
      const target = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h1', vectors: [target] },
        { sourceId: 'm2', textHash: 'h2', vectors: [unit(3)] },
      ]);

      expect(
        await store.scoreDocuments('memory', MODEL, target, ['m2'], 10),
      ).toEqual([]);
      expect(
        (await store.scoreDocuments('memory', MODEL, target, ['m1'], 10)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['m1']);
      expect(
        await store.scoreDocuments('memory', MODEL, target, [], 10),
      ).toEqual([]);
    });

    it('answers at most the limit, best first', async () => {
      const target = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'd1', textHash: 'h', vectors: [target] },
        {
          sourceId: 'd2',
          textHash: 'h',
          vectors: [near(target, unit(4), 0.2)],
        },
        {
          sourceId: 'd3',
          textHash: 'h',
          vectors: [near(target, unit(5), 0.8)],
        },
      ]);

      expect(
        (await store.scoreDocuments('memory', MODEL, target, null, 10)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['d1', 'd2', 'd3']);
      expect(
        (await store.scoreDocuments('memory', MODEL, target, null, 2)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['d1', 'd2']);
    });

    it('never compares vectors stored under another model', async () => {
      const target = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'd1', textHash: 'h', vectors: [target] },
      ]);
      await store.storeDocuments('memory', OTHER, [
        { sourceId: 'd2', textHash: 'h', vectors: [target] },
      ]);

      expect(
        (await store.scoreDocuments('memory', MODEL, target, null, 10)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['d1']);
      expect(
        (await store.scoreDocuments('memory', OTHER, target, null, 10)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['d2']);
    });

    it("replaces a document's chunks when it is stored again", async () => {
      const old = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h1', vectors: [unit(2), old] },
      ]);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h2', vectors: [unit(3)] },
      ]);

      expect(
        await store.scoreDocuments('memory', MODEL, old, null, 10),
      ).toEqual([]);
      expect(
        await store.missingDocuments('memory', MODEL, [
          { sourceId: 'm1', textHash: 'h2' },
        ]),
      ).toEqual([]);
    });

    it('reports a document missing when it is absent or its text hash changed', async () => {
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h1', vectors: [unit(1)] },
      ]);

      expect(
        await store.missingDocuments('memory', MODEL, [
          { sourceId: 'm1', textHash: 'h1' },
          { sourceId: 'm2', textHash: 'h2' },
        ]),
      ).toEqual(['m2']);
      expect(
        await store.missingDocuments('memory', MODEL, [
          { sourceId: 'm1', textHash: 'changed' },
        ]),
      ).toEqual(['m1']);
      expect(
        await store.missingDocuments('memory', OTHER, [
          { sourceId: 'm1', textHash: 'h1' },
        ]),
      ).toEqual(['m1']);
    });

    it('deletes documents by id and only from their own source', async () => {
      const target = unit(1);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [target] },
      ]);
      await store.storeDocuments('knowledge', MODEL, [
        { sourceId: 'k1', textHash: 'h', vectors: [target] },
      ]);

      expect(await store.deleteDocuments('memory', ['m1', 'ghost'])).toBe(1);

      expect(
        await store.scoreDocuments('memory', MODEL, target, null, 10),
      ).toEqual([]);
      expect(
        (await store.scoreDocuments('knowledge', MODEL, target, null, 10)).map(
          (hit) => hit.sourceId,
        ),
      ).toEqual(['k1']);
    });

    it('counts the documents of each source under one model', async () => {
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [unit(1), unit(2)] },
        { sourceId: 'm2', textHash: 'h', vectors: [unit(3)] },
      ]);
      await store.storeDocuments('knowledge', MODEL, [
        { sourceId: 'k1', textHash: 'h', vectors: [unit(4)] },
      ]);
      await store.storeDocuments('memory', OTHER, [
        { sourceId: 'm3', textHash: 'h', vectors: [unit(5)] },
      ]);

      expect(await store.counts(MODEL)).toEqual({
        memory: 2,
        knowledge: 1,
        chats: 0,
      });
      expect(await store.counts(OTHER)).toEqual({
        memory: 1,
        knowledge: 0,
        chats: 0,
      });
    });
  });

  describe('chat messages', () => {
    it('answers the nearest messages across every run, best first', async () => {
      await store.storeChatItems(MODEL, [
        chatItem('i1', 'r1', 1),
        chatItem('i2', 'r2', 2),
        chatItem('i3', 'r2', 3),
      ]);

      const hits = await store.searchChats(MODEL, unit(2), 10, null);

      expect(hits[0]?.itemId).toBe('i2');
      expect(hits[0]?.runId).toBe('r2');
      expect(hits[0]?.similarity).toBeGreaterThan(0.95);
      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 3,
      });
    });

    it('drops a chat message a document would still match, below the stricter chat floor', async () => {
      const target = unit(1);
      const weak = near(target, unit(2), 1.08);
      await store.storeChatItems(MODEL, [
        { ...chatItem('weak', 'r1', 1), vectors: [weak] },
        {
          ...chatItem('close', 'r1', 3),
          vectors: [near(target, unit(4), 0.6)],
        },
      ]);
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [weak] },
      ]);

      const chats = await store.searchChats(MODEL, target, 10, null);
      const scoped = await store.searchChats(MODEL, target, 10, ['r1']);
      const documents = await store.scoreDocuments(
        'memory',
        MODEL,
        target,
        null,
        10,
      );

      expect(chats.map((hit) => hit.itemId)).toEqual(['close']);
      expect(scoped.map((hit) => hit.itemId)).toEqual(['close']);
      expect(documents.map((hit) => hit.sourceId)).toEqual(['m1']);
      expect(documents[0]?.similarity).toBeGreaterThan(0.65);
      expect(documents[0]?.similarity).toBeLessThan(0.7);
    });

    it('compares chat messages of the same model only', async () => {
      await store.storeChatItems(OTHER, [chatItem('i1', 'r1', 7)]);

      expect(await store.searchChats(MODEL, unit(7), 10, null)).toEqual([]);
      expect(
        (await store.searchChats(OTHER, unit(7), 10, null)).map(
          (hit) => hit.itemId,
        ),
      ).toEqual(['i1']);
    });

    it('restricts a scoped search to the runs it names', async () => {
      await store.storeChatItems(MODEL, [
        chatItem('a1', 'r1', 11),
        chatItem('b1', 'r2', 12),
      ]);

      const inR1 = await store.searchChats(MODEL, unit(12), 10, ['r1']);
      expect(inR1.every((hit) => hit.runId === 'r1')).toBe(true);
      expect(inR1.map((hit) => hit.itemId)).not.toContain('b1');
      expect(
        (await store.searchChats(MODEL, unit(12), 10, ['r2'])).map(
          (hit) => hit.itemId,
        ),
      ).toEqual(['b1']);
      expect(
        (await store.searchChats(MODEL, unit(12), 10, ['r1', 'r2'])).map(
          (hit) => hit.itemId,
        ),
      ).toContain('b1');
    });

    it('drops every chunk of a deleted run', async () => {
      await store.storeChatItems(MODEL, [
        chatItem('a1', 'r1', 21),
        chatItem('a2', 'r1', 22),
        chatItem('b1', 'r2', 23),
      ]);

      expect(await store.deleteRuns(['r1'])).toBe(2);

      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 1,
      });
      expect(
        (await store.searchChats(MODEL, unit(21), 10, null)).map(
          (hit) => hit.runId,
        ),
      ).not.toContain('r1');
      expect(
        (await store.searchChats(MODEL, unit(21), 10, ['r1'])).length,
      ).toBe(0);
    });

    it('keeps the runs it is told to keep and drops the rest', async () => {
      await store.storeChatItems(MODEL, [
        chatItem('a1', 'r1', 31),
        chatItem('b1', 'r2', 32),
        chatItem('c1', 'r3', 33),
        chatItem('c2', 'r3', 34),
      ]);

      expect(await store.keepRuns(['r2'])).toBe(3);

      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 1,
      });
      expect(
        (await store.searchChats(MODEL, unit(32), 10, null)).map(
          (hit) => hit.itemId,
        ),
      ).toEqual(['b1']);
    });

    it('re-indexes a message whose text changed, replacing its chunks', async () => {
      await store.storeChatItems(MODEL, [chatItem('i1', 'r1', 41)]);
      await store.storeChatItems(MODEL, [
        { ...chatItem('i1', 'r1', 42), textHash: 'changed' },
      ]);

      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 1,
      });
      expect(await store.searchChats(MODEL, unit(41), 10, null)).toEqual([]);
      expect(
        await store.missingChatItems(MODEL, [
          { itemId: 'i1', textHash: 'changed' },
        ]),
      ).toEqual([]);
    });
  });

  describe('model and reset', () => {
    it('keeps only the vectors of the model it is told to keep', async () => {
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [unit(1)] },
      ]);
      await store.storeDocuments('memory', OTHER, [
        { sourceId: 'm2', textHash: 'h', vectors: [unit(2)] },
      ]);
      await store.storeChatItems(OTHER, [chatItem('i1', 'r1', 3)]);
      await store.storeChatItems(MODEL, [chatItem('i2', 'r1', 4)]);

      await store.keepOnlyModel(MODEL);

      expect(await store.counts(OTHER)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 0,
      });
      expect(await store.counts(MODEL)).toEqual({
        memory: 1,
        knowledge: 0,
        chats: 1,
      });
    });

    it('empties the index and keeps only the schema version in meta', async () => {
      await store.setMeta('chats:x:fwd', '5');
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [unit(1)] },
      ]);
      await store.storeChatItems(MODEL, [chatItem('i1', 'r1', 2)]);

      await store.clear();

      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: 0,
      });
      expect(await store.getMeta('chats:x:fwd')).toBeNull();
      expect(await store.getMeta('schema_version')).toBe('1');
    });

    it('vacuums nothing when no deletion asked for it', async () => {
      await store.storeDocuments('memory', MODEL, manyDocuments(300));
      await store.deleteDocuments(
        'memory',
        manyDocuments(300).map((doc) => doc.sourceId),
      );
      expect(freelistPages(path)).toBeGreaterThan(0);
      const freeBefore = freelistPages(path);

      store.vacuumIfDue();

      expect(freelistPages(path)).toBe(freeBefore);
    });

    it('marks the file due for a vacuum when it clears the index', async () => {
      await store.storeDocuments('memory', MODEL, manyDocuments(300));
      await store.clear();
      expect(freelistPages(path)).toBeGreaterThan(0);

      store.vacuumIfDue();

      expect(freelistPages(path)).toBe(0);
    });

    it('stores a meta value, overwrites it and deletes it when set to null', async () => {
      await store.setMeta('cursor', 'first');
      await store.setMeta('cursor', 'second');
      expect(await store.getMeta('cursor')).toBe('second');

      await store.setMeta('cursor', null);
      expect(await store.getMeta('cursor')).toBeNull();
    });
  });

  describe('deletions queued while the child was down', () => {
    it('drains them when the store opens again', async () => {
      await store.storeDocuments('memory', MODEL, [
        { sourceId: 'm1', textHash: 'h', vectors: [unit(1)] },
        { sourceId: 'm2', textHash: 'h', vectors: [unit(2)] },
      ]);
      await store.storeChatItems(MODEL, [chatItem('c1', 'r9', 3)]);
      store.close();

      const daemon = new DatabaseSync(path);
      daemon
        .prepare(
          'INSERT INTO deletions (source, source_id, run_id, queued_at) VALUES (?, ?, ?, ?)',
        )
        .run('memory', 'm1', null, 1);
      daemon
        .prepare(
          'INSERT INTO deletions (source, source_id, run_id, queued_at) VALUES (?, ?, ?, ?)',
        )
        .run('chats', null, 'r9', 2);
      daemon.close();

      store = await EmbeddingStore.open(path);

      expect(await store.counts(MODEL)).toEqual({
        memory: 1,
        knowledge: 0,
        chats: 0,
      });
      const check = new DatabaseSync(path);
      try {
        const left = check
          .prepare('SELECT COUNT(*) AS n FROM deletions')
          .get() as { n: number };
        expect(left.n).toBe(0);
      } finally {
        check.close();
      }
    });
  });

  describe('a corpus of 2 000 chat chunks', () => {
    it('answers a global and a scoped search within the latency bound', async () => {
      await storeCorpus(store);
      expect(await store.counts(MODEL)).toEqual({
        memory: 0,
        knowledge: 0,
        chats: CORPUS_RUNS * CORPUS_ITEMS_PER_RUN,
      });

      const globalStarted = performance.now();
      const global = await store.searchChats(MODEL, unit(1000 + 777), 20, null);
      const globalMs = performance.now() - globalStarted;

      const scopedStarted = performance.now();
      const scoped = await store.searchChats(
        MODEL,
        unit(1000 + 7 * CORPUS_ITEMS_PER_RUN + 3),
        20,
        [runName(7)],
      );
      const scopedMs = performance.now() - scopedStarted;

      process.stdout.write(
        `KNN over 2000 chunks: global ${globalMs.toFixed(1)} ms, scoped ${scopedMs.toFixed(1)} ms\n`,
      );
      expect(global[0]?.itemId).toBe('item-777');
      expect(globalMs).toBeLessThan(LATENCY_BOUND_MS);
      expect(scoped[0]?.itemId).toBe(`item-${7 * CORPUS_ITEMS_PER_RUN + 3}`);
      expect(scoped.every((hit) => hit.runId === runName(7))).toBe(true);
      expect(scopedMs).toBeLessThan(LATENCY_BOUND_MS);
    }, 60_000);

    it('vacuums once deletions pass 10% of the chunks, and the file does not grow', async () => {
      await storeCorpus(store);
      const before = checkpointedSize(path);

      expect(await store.deleteRuns([runName(0), runName(1)])).toBe(100);
      expect(await store.getMeta('chat_deleted_since_vacuum')).toBe('100');
      const afterFivePercent = checkpointedSize(path);
      expect(freelistPages(path)).toBeGreaterThan(0);

      expect(await store.deleteRuns([runName(2), runName(3), runName(4)])).toBe(
        150,
      );
      expect(await store.getMeta('chat_deleted_since_vacuum')).toBeNull();
      expect(freelistPages(path)).toBeGreaterThan(0);
      store.vacuumIfDue();
      expect(freelistPages(path)).toBe(0);
      const afterVacuum = checkpointedSize(path);

      process.stdout.write(
        `embeddings.db bytes: before ${before}, after 5% deleted ${afterFivePercent}, after 12.5% deleted and vacuumed ${afterVacuum}\n`,
      );
      expect(afterVacuum).toBeLessThan(before);
    }, 60_000);
  });
});
