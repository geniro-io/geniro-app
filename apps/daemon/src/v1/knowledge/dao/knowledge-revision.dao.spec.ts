import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { knowledgeDb } from '../__tests__/knowledge-db';
import { KnowledgeRevision } from '../entity/knowledge-revision.entity';
import type { KnowledgeRevisionStatus } from '../knowledge.types';
import { KnowledgeRevisionDao } from './knowledge-revision.dao';

type Db = Awaited<ReturnType<typeof knowledgeDb>>;

describe('KnowledgeRevisionDao.pendingHeads', () => {
  let db: Db;

  beforeEach(async () => {
    db = await knowledgeDb();
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  async function seed(
    title: string,
    status: KnowledgeRevisionStatus,
    createdAt: Date,
  ): Promise<string> {
    const revision = Object.assign(new KnowledgeRevision(), {
      documentId: 'doc-1',
      status,
      baseRev: 1,
      handle: 'k1',
      title,
      whenToRead: '',
      body: 'body',
      bodyBytes: 4,
      sourceActor: 'agent',
      createdAt,
    } satisfies Partial<KnowledgeRevision>);
    const fork = db.em.fork();
    fork.persist(revision);
    await fork.flush();
    return revision.id;
  }

  it('lists only pending revisions, oldest first', async () => {
    const newest = await seed('Newest', 'pending', new Date('2026-03-01'));
    const oldest = await seed('Oldest', 'pending', new Date('2026-01-01'));
    await seed('Applied', 'applied', new Date('2026-01-02'));
    await seed('Rejected', 'rejected', new Date('2026-01-03'));

    const heads = await new KnowledgeRevisionDao(db.em).pendingHeads(
      db.em.fork(),
    );

    expect(heads).toEqual([
      { id: oldest, title: 'Oldest' },
      { id: newest, title: 'Newest' },
    ]);
  });
});
