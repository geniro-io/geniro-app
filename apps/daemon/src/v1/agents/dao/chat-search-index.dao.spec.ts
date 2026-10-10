import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { GlobalChatSearchQuerySchema } from '../chat-search.types';
import { ChatSearchChunk } from '../entity/chat-search-chunk.entity';
import { ChatSearchIndexDao } from './chat-search-index.dao';

describe('ChatSearchIndexDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ChatSearchIndexDao;
  const options = GlobalChatSearchQuerySchema.parse({ query: 'discount' });
  const timestamp = new Date('2026-01-01T00:00:00Z');

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, ChatSearchChunk],
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    dao = new ChatSearchIndexDao(orm.em.fork());
  });

  async function run(id: string, extra: Partial<Run> = {}): Promise<void> {
    const em = orm.em.fork();
    em.persist(
      em.create(Run, {
        id,
        status: 'pending',
        title: id,
        cwd: '/project',
        createdAt: timestamp,
        updatedAt: timestamp,
        ...extra,
      }),
    );
    await em.flush();
  }

  async function item(
    id: string,
    runId = 'run-a',
    extra: Partial<Item> = {},
  ): Promise<Item> {
    const em = orm.em.fork();
    const row = em.create(Item, {
      id,
      runId,
      seq: 1,
      kind: 'message',
      role: 'user',
      payload: JSON.stringify({ text: 'discount' }),
      searchText: 'discount',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...extra,
    });
    em.persist(row);
    await em.flush();
    return row;
  }

  async function cache(
    itemId: string,
    count = 1,
    modelKey = 'model-a',
  ): Promise<void> {
    const em = orm.em.fork();
    for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
      em.persist(
        em.create(ChatSearchChunk, {
          itemId,
          modelKey,
          chunkIndex,
          textOffset: chunkIndex * 10,
          textHash: `hash-${itemId}`,
          vector: '[1,0]',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    await em.flush();
  }

  it('matches literal wildcard characters and requires every term', async () => {
    await run('run-a');
    await item('literal', 'run-a', { searchText: 'DISCOUNT %_\\ special' });
    await item('wildcard', 'run-a', { searchText: 'discount abc special' });
    await item('one-term', 'run-a', { searchText: '%_\\ only' });
    expect(
      (await dao.keywords(options, ['discount', '%_\\'], 30)).map(
        (row) => row.id,
      ),
    ).toEqual(['literal']);
    expect(await dao.keywords(options, [], 30)).toEqual([]);
    expect(await dao.keywords(options, ["' OR 1=1 --"], 30)).toEqual([]);
  });

  it('preserves live-row, archive, project and run filters with numeric timestamps', async () => {
    await run('run-a');
    await run('run-archived', { archivedAt: timestamp });
    await run('run-other', { cwd: '/other' });
    await run('run-deleted', { deletedAt: timestamp });
    await item('active');
    await item('archived', 'run-archived');
    await item('other', 'run-other');
    await item('deleted-run', 'run-deleted');
    await item('deleted-item', 'run-a', { deletedAt: timestamp });
    await item('empty', 'run-a', { searchText: '' });
    await item('unindexed', 'run-a', { searchText: null });
    const rows = await dao.keywords(options, ['discount'], 30);
    expect(rows.map((row) => row.id)).toEqual(['other', 'archived', 'active']);
    expect(rows.find((row) => row.id === 'archived')).toMatchObject({
      runId: 'run-archived',
      title: 'run-archived',
      cwd: '/project',
      archivedAt: timestamp.getTime(),
      createdAt: timestamp.getTime(),
      searchText: 'discount',
    });
    expect(
      (
        await dao.keywords(
          { ...options, includeArchived: false, cwd: '/project' },
          ['discount'],
          30,
        )
      ).map((row) => row.id),
    ).toEqual(['active']);
    expect(
      (
        await dao.keywords(
          { ...options, runId: 'run-archived' },
          ['discount'],
          30,
        )
      ).map((row) => row.id),
    ).toEqual(['archived']);
    expect(
      (await dao.keywords(options, ['discount'], 1)).map((row) => row.id),
    ).toEqual(['other']);
  });

  it('orders newest messages first before breaking timestamp ties by id', async () => {
    await run('run-a');
    await item('z-old');
    await item('a-new', 'run-a', {
      createdAt: new Date(timestamp.getTime() + 1),
    });
    expect(
      (await dao.keywords(options, ['discount'], 1)).map((row) => row.id),
    ).toEqual(['a-new']);
  });

  it('scans uncached messages and only joins the requested model first chunk', async () => {
    await run('run-a');
    await item('a');
    await item('b');
    await item('c');
    await item('d-tool', 'run-a', { kind: 'tool_result' });
    await cache('a', 2);
    await cache('b', 1, 'other-model');
    expect(await dao.documents('', 'model-a')).toEqual([
      {
        id: 'a',
        payload: JSON.stringify({ text: 'discount' }),
        searchText: 'discount',
        textHash: 'hash-a',
      },
      {
        id: 'b',
        payload: JSON.stringify({ text: 'discount' }),
        searchText: 'discount',
        textHash: null,
      },
      {
        id: 'c',
        payload: JSON.stringify({ text: 'discount' }),
        searchText: 'discount',
        textHash: null,
      },
    ]);
    expect(
      (await dao.documents('a', 'other-model')).map((row) => [
        row.id,
        row.textHash,
      ]),
    ).toEqual([
      ['b', 'hash-b'],
      ['c', null],
    ]);
    const em = orm.em.fork();
    for (let index = 0; index < 151; index++) {
      em.persist(
        em.create(Item, {
          id: `page-${String(index).padStart(3, '0')}`,
          runId: 'run-a',
          seq: index,
          kind: 'message',
          payload: '{}',
          searchText: 'discount',
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
    }
    await em.flush();
    const page = await dao.documents('d-tool', 'model-a');
    expect(page).toHaveLength(150);
    expect(
      (await dao.documents(page[149]!.id, 'model-a')).map((row) => row.id),
    ).toEqual(['page-150']);
  });

  it('paginates vectors within an item without skipping the next item or leaking scope', async () => {
    await run('run-a');
    await run('run-archived', { archivedAt: timestamp });
    await item('a');
    await item('b');
    await item('c-archived', 'run-archived');
    await cache('a', 501);
    await cache('b');
    await cache('b', 1, 'other-model');
    await cache('c-archived');
    const page = await dao.vectors(options, 'model-a', '', -1);
    expect(page).toHaveLength(500);
    expect(page[499]).toMatchObject({
      id: 'a',
      chunkIndex: 499,
      textOffset: 4990,
      vector: '[1,0]',
    });
    const next = await dao.vectors(
      { ...options, includeArchived: false },
      'model-a',
      'a',
      499,
    );
    expect(next.map((row) => [row.id, row.chunkIndex])).toEqual([
      ['a', 500],
      ['b', 0],
    ]);
    expect(
      await dao.vectors({ ...options, cwd: '/other' }, 'model-a', '', -1),
    ).toEqual([]);
    expect(
      (
        await dao.vectors(
          { ...options, runId: 'run-archived' },
          'model-a',
          '',
          -1,
        )
      ).map((row) => row.id),
    ).toEqual(['c-archived']);
  });

  it('replaces cache atomically and retains it when insertion fails or the payload changed', async () => {
    await run('run-a');
    await item('a');
    await cache('a');
    const document = (await dao.documents('', 'model-a'))[0]!;
    await expect(
      dao.save(document, 'new-model', 'new-hash', [
        { text: 'discount', textOffset: 0, vector: [0, 1] },
        {
          text: 'discount',
          textOffset: null as unknown as number,
          vector: [0, 1],
        },
      ]),
    ).rejects.toThrow(
      'NOT NULL constraint failed: chat_search_chunks.text_offset',
    );
    expect(
      (await dao.vectors(options, 'model-a', '', -1)).map(
        (row) => row.textHash,
      ),
    ).toEqual(['hash-a']);
    expect(await dao.vectors(options, 'new-model', '', -1)).toEqual([]);
    await dao.save(
      { ...document, payload: 'stale' },
      'new-model',
      'new-hash',
      [],
    );
    expect(
      (await dao.vectors(options, 'model-a', '', -1)).map(
        (row) => row.textHash,
      ),
    ).toEqual(['hash-a']);
    await dao.save(document, 'new-model', 'new-hash', [
      { text: 'discount', textOffset: 7, vector: [0, 1] },
      { text: 'count', textOffset: 3, vector: [1, 0] },
    ]);
    expect(await dao.vectors(options, 'model-a', '', -1)).toEqual([]);
    expect(
      (await dao.vectors(options, 'new-model', '', -1)).map((row) => ({
        id: row.id,
        chunkIndex: row.chunkIndex,
        textHash: row.textHash,
        textOffset: row.textOffset,
        vector: row.vector,
      })),
    ).toEqual([
      {
        id: 'a',
        chunkIndex: 0,
        textHash: 'new-hash',
        textOffset: 7,
        vector: '[0,1]',
      },
      {
        id: 'a',
        chunkIndex: 1,
        textHash: 'new-hash',
        textOffset: 3,
        vector: '[1,0]',
      },
    ]);
  });

  it('prunes missing, deleted and unsearchable transcripts and omits deleted payloads', async () => {
    await run('run-a');
    await run('run-deleted', { deletedAt: timestamp });
    await item('active');
    await item('deleted-item', 'run-a', { deletedAt: timestamp });
    await item('deleted-run', 'run-deleted');
    await item('empty', 'run-a', { searchText: '' });
    await item('unindexed', 'run-a', { searchText: null });
    for (const id of [
      'active',
      'deleted-item',
      'deleted-run',
      'empty',
      'unindexed',
      'missing',
    ]) {
      await cache(id);
    }
    const [document] = await dao.documents('', 'model-a');
    await dao.save(
      { ...document!, id: 'deleted-item' },
      'new-model',
      'new-hash',
      [],
    );
    await dao.save(
      { ...document!, id: 'deleted-run' },
      'new-model',
      'new-hash',
      [],
    );
    expect(await orm.em.fork().count(ChatSearchChunk, {})).toBe(6);
    await dao.prune();
    const chunks = await orm.em.fork().find(ChatSearchChunk, {});
    expect(chunks.map((row) => row.itemId)).toEqual(['active']);
    expect(await dao.payloads(['active', 'deleted-item', 'missing'])).toEqual(
      new Map([['active', JSON.stringify({ text: 'discount' })]]),
    );
    expect(await dao.payloads([])).toEqual(new Map());
  });
});
