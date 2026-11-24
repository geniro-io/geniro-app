import type { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  asEmbeddingIndex,
  FakeEmbeddingIndex,
} from '../../embeddings/__tests__/fake-embedding-index';
import { chatSearchDb, said } from '../__tests__/chat-search-db';
import { GlobalChatSearchService } from './global-chat-search.service';

const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_ARCHIVED = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date('2026-01-01T00:00:00Z');
const RUSSIAN_IMAGES = 'почему не открываются картинки в чате';

describe('GlobalChatSearchService search by meaning', () => {
  let db: Awaited<ReturnType<typeof chatSearchDb>>;
  let orm: MikroORM;
  let fake: FakeEmbeddingIndex;
  let service: GlobalChatSearchService;

  beforeEach(async () => {
    db = await chatSearchDb();
    orm = db.orm;
    await db.run(RUN_A, { title: 'Billing', cwd: '/shop' });
    await db.run(RUN_ARCHIVED, {
      title: 'Old chat',
      cwd: '/old',
      archivedAt: NOW,
    });
    await db.item('pic', {
      runId: RUN_A,
      seq: 1,
      payload: said('Pasted screenshots must live at a path without spaces.'),
    });
    await db.item('other', {
      runId: RUN_A,
      seq: 2,
      payload: said('Billing totals for March.'),
    });
    await db.item('old', {
      runId: RUN_ARCHIVED,
      seq: 1,
      payload: said('Old screenshots note about the pasted images folder.'),
    });
    await db.item('filler', {
      runId: RUN_A,
      seq: 3,
      role: 'assistant',
      payload: said('Done.'),
    });
    await db.ensureIndex();
    fake = new FakeEmbeddingIndex();
    service = new GlobalChatSearchService(db.dao(), asEmbeddingIndex(fake));
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('adds a meaning-only message with its fields and a snippet, scored in (0, 1]', async () => {
    fake.answerChats = () => [{ itemId: 'pic', runId: RUN_A, similarity: 0.8 }];

    const result = await service.search({
      query: RUSSIAN_IMAGES,
      limit: 30,
      includeArchived: true,
    });

    expect(result.hits).toHaveLength(1);
    const [hit] = result.hits;
    expect(hit).toMatchObject({
      runId: RUN_A,
      itemId: 'pic',
      title: 'Billing',
      cwd: '/shop',
      archived: false,
      seq: 1,
      kind: 'message',
      role: 'user',
    });
    expect(hit?.snippet).toContain('Pasted screenshots');
    expect(hit?.score).toBeGreaterThan(0);
    expect(hit?.score).toBeLessThanOrEqual(1);
    expect(Object.keys(hit ?? {}).sort()).toEqual(
      [
        'archived',
        'createdAt',
        'cwd',
        'itemId',
        'kind',
        'memberId',
        'runId',
        'role',
        'score',
        'seq',
        'snippet',
        'title',
      ].sort(),
    );
  });

  it('never answers a short filler message by meaning, while a real paraphrase still comes back and words still find the filler', async () => {
    fake.answerChats = () => [
      { itemId: 'filler', runId: RUN_A, similarity: 0.93 },
      { itemId: 'pic', runId: RUN_A, similarity: 0.76 },
    ];

    const byMeaning = await service.search({
      query: RUSSIAN_IMAGES,
      limit: 30,
      includeArchived: true,
    });
    fake.answerChats = () => [];
    const byWords = await service.search({
      query: 'done',
      limit: 30,
      includeArchived: true,
    });

    expect(byMeaning.hits.map((hit) => hit.itemId)).toEqual(['pic']);
    expect(byWords.hits.map((hit) => hit.itemId)).toEqual(['filler']);
  });

  it('puts the best fused hit first with score 1 and keeps the others below it', async () => {
    fake.answerChats = () => [{ itemId: 'pic', runId: RUN_A, similarity: 0.9 }];

    const result = await service.search({
      query: 'screenshots',
      limit: 30,
      includeArchived: true,
    });

    expect(result.hits.map((hit) => hit.itemId)).toEqual(['pic', 'old']);
    const [first, second] = result.hits;
    expect(first?.score).toBe(1);
    expect(second?.score).toBeGreaterThan(0);
    expect(second?.score).toBeLessThan(1);
  });

  it('leaves an archived chat out when includeArchived is false, even if meaning returns it', async () => {
    fake.answerChats = () => [
      { itemId: 'old', runId: RUN_ARCHIVED, similarity: 0.9 },
      { itemId: 'pic', runId: RUN_A, similarity: 0.8 },
    ];

    const withoutArchived = await service.search({
      query: RUSSIAN_IMAGES,
      limit: 30,
      includeArchived: false,
    });
    const withArchived = await service.search({
      query: RUSSIAN_IMAGES,
      limit: 30,
      includeArchived: true,
    });

    expect(withoutArchived.hits.map((hit) => hit.itemId)).toEqual(['pic']);
    expect(withArchived.hits.map((hit) => hit.itemId)).toEqual(['old', 'pic']);
  });

  it('passes the runs a scoped search can reach to the child, and every run for a global one', async () => {
    fake.answerChats = () => [];

    await service.search({
      query: 'screenshots',
      runId: RUN_A,
      limit: 30,
      includeArchived: true,
    });
    await service.search({
      query: 'screenshots',
      limit: 5,
      includeArchived: true,
    });

    expect(fake.chatCalls[0]).toEqual({
      query: 'screenshots',
      k: 300,
      runIds: [RUN_A],
    });
    expect(fake.chatCalls[1]).toEqual({
      query: 'screenshots',
      k: 50,
      runIds: null,
    });
  });

  it('answers the same as the word search when the child answers nothing', async () => {
    const words = await new GlobalChatSearchService(db.dao()).search({
      query: 'screenshots',
      limit: 30,
      includeArchived: true,
    });
    fake.answerChats = () => null;

    const answered = await service.search({
      query: 'screenshots',
      limit: 30,
      includeArchived: true,
    });

    expect(answered).toEqual(words);
  });
});
