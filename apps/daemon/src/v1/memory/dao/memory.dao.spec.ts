import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { make, memoryDb } from '../__tests__/memory-db';
import { Memory } from '../entity/memory.entity';
import type { MemoryStatus } from '../memory.types';
import { MemoryDao } from './memory.dao';

type Db = Awaited<ReturnType<typeof memoryDb>>;

describe('MemoryDao.pendingEntries', () => {
  let db: Db;

  beforeEach(async () => {
    db = await memoryDb();
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  async function seed(
    handle: number,
    status: MemoryStatus,
    createdAt: Date,
    deletedAt: Date | null = null,
  ): Promise<string> {
    const entry = make(Memory, {
      handle,
      title: `title ${handle}`,
      body: `body ${handle}`,
      type: 'project',
      status,
      sourceActor: 'agent',
      createdAt,
      deletedAt,
    });
    const fork = db.em.fork();
    fork.persist(entry);
    await fork.flush();
    return entry.id;
  }

  it('lists only pending entries that are not soft-deleted, oldest first', async () => {
    const newest = await seed(1, 'pending', new Date('2026-03-01'));
    const oldest = await seed(2, 'pending', new Date('2026-01-01'));
    await seed(3, 'active', new Date('2026-01-02'));
    await seed(4, 'forgotten', new Date('2026-01-03'));
    await seed(5, 'pending', new Date('2026-01-04'), new Date('2026-02-01'));

    const pending = await new MemoryDao(db.em).pendingEntries(db.em.fork());

    expect(pending).toEqual([
      { id: oldest, title: 'title 2' },
      { id: newest, title: 'title 1' },
    ]);
  });
});
