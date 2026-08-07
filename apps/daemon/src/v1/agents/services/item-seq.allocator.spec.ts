import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../dao/item.dao';
import { ItemSeqAllocator } from './item-seq.allocator';

/** An `em` whose only use here is `fork()` for the seeding read. */
const em = { fork: () => ({}) } as unknown as EntityManager;

function setup(maxSeq: (runId: string) => Promise<number> | number): {
  allocator: ItemSeqAllocator;
  reads: () => number;
} {
  let reads = 0;
  const itemDao = {
    maxSeq: vi.fn(async (runId: string) => {
      reads += 1;
      return await maxSeq(runId);
    }),
  } as unknown as ItemDao;
  return { allocator: new ItemSeqAllocator(em, itemDao), reads: () => reads };
}

describe('ItemSeqAllocator', () => {
  it('continues from the run’s highest committed seq', async () => {
    const { allocator } = setup(() => 5926);

    expect(await allocator.reserve('run')).toBe(5927);
    expect(await allocator.reserve('run')).toBe(5928);
  });

  it('starts a run with no items at 0', async () => {
    // The DAO reports -1 for an empty run (matching `maxSeq`'s contract), so
    // the first item of a fresh chat must be seq 0 — the transcript's `afterSeq`
    // cursor starts at -1 and would skip a first item numbered below it.
    const { allocator } = setup(() => -1);

    expect(await allocator.reserve('run')).toBe(0);
  });

  it('never issues one value twice to concurrent callers', async () => {
    // THE property the class exists for. The two writers of a chat's
    // transcript — a turn's event chain and the HTTP handler delivering a
    // mid-turn follow-up — run on independent promise chains, so a
    // read-modify-write without serialization hands both the same number
    // across its await. The seeding read is deliberately slow here so every
    // caller is in flight before the first one resolves.
    const { allocator, reads } = setup(
      async () =>
        await new Promise<number>((resolve) =>
          setTimeout(() => resolve(41), 5),
        ),
    );

    const issued = await Promise.all(
      Array.from({ length: 20 }, () => allocator.reserve('run')),
    );

    expect(new Set(issued).size).toBe(20);
    expect([...issued].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => 42 + i),
    );
    // Seeded ONCE: re-reading per call is what made the database — which
    // cannot see an uncommitted reservation — the source of the collision.
    expect(reads()).toBe(1);
  });

  it('keeps runs independent', async () => {
    const { allocator } = setup((runId) => (runId === 'a' ? 10 : 100));

    expect(await allocator.reserve('a')).toBe(11);
    expect(await allocator.reserve('b')).toBe(101);
    expect(await allocator.reserve('a')).toBe(12);
  });

  it('reserves a contiguous block', async () => {
    const { allocator } = setup(() => 0);

    expect(await allocator.reserve('run', 3)).toBe(1);
    // The block is HELD: the next caller starts past it, not inside it.
    expect(await allocator.reserve('run')).toBe(4);
  });

  it('re-seeds from the database after the run is forgotten', async () => {
    // `forget` runs at teardown, when the rows are being destroyed. Nothing
    // should reserve afterwards, but if something does it must not continue
    // from a tail describing rows that no longer exist.
    const { allocator, reads } = setup(() => 7);

    expect(await allocator.reserve('run')).toBe(8);
    allocator.forget('run');
    expect(await allocator.reserve('run')).toBe(8);
    expect(reads()).toBe(2);
  });

  it('recovers when a seeding read fails', async () => {
    // A transient read error must not wedge the run's allocator forever —
    // the chain is deliberately continued on rejection as well as fulfilment,
    // and this is the test that enters that branch.
    let attempt = 0;
    const { allocator } = setup(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('db unavailable');
      }
      return 3;
    });

    await expect(allocator.reserve('run')).rejects.toThrow('db unavailable');
    expect(await allocator.reserve('run')).toBe(4);
  });

  it('rejects a nonsensical block size instead of issuing a stuck tail', async () => {
    const { allocator } = setup(() => 0);

    await expect(allocator.reserve('run', 0)).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
