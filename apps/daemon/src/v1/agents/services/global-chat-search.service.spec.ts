import type { MikroORM } from '@mikro-orm/sqlite';
import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { chatSearchDb, said } from '../__tests__/chat-search-db';
import { MAX_CONTEXT_ITEM_CHARS } from '../chat.types';
import { GlobalChatSearchService } from './global-chat-search.service';

const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_GONE = '00000000-0000-4000-8000-00000000000c';
const RUN_BUILDER = '00000000-0000-4000-8000-00000000000d';

describe('GlobalChatSearchService (in-memory sqlite)', () => {
  let db: Awaited<ReturnType<typeof chatSearchDb>>;
  let orm: MikroORM;
  let service: GlobalChatSearchService;

  beforeEach(async () => {
    db = await chatSearchDb();
    orm = db.orm;
    service = new GlobalChatSearchService(db.dao());
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('shapes a hit with its run, item, snippet and a higher-is-better score', async () => {
    await db.run(RUN_A, { title: 'Billing', cwd: '/shop' });
    // Written first and alike in age, so only the relevance order can put
    // the stronger match ahead of it.
    await db.item('weak', {
      runId: RUN_A,
      seq: 8,
      payload: said(`${'filler '.repeat(60)}idempotency at the end`),
    });
    await db.item('strong', {
      runId: RUN_A,
      seq: 7,
      role: 'assistant',
      payload: said('Idempotency idempotency idempotency key'),
    });
    await db.ensureIndex();

    const result = await service.search({
      query: 'idempot',
      limit: 30,
      includeArchived: true,
    });
    expect(result.partialReason).toBeNull();
    expect(result.hits.map((hit) => hit.itemId)).toEqual(['strong', 'weak']);
    const [first, second] = result.hits;
    expect(first).toMatchObject({
      runId: RUN_A,
      itemId: 'strong',
      seq: 7,
      kind: 'message',
      role: 'assistant',
      title: 'Billing',
      cwd: '/shop',
      archived: false,
      snippet: 'Idempotency idempotency idempotency key',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(first!.score).toBeGreaterThan(second!.score);
    // The snippet is a window on the match, not the whole message.
    expect(second!.snippet).toContain('idempotency');
    expect(second!.snippet.startsWith('…')).toBe(true);
  });

  it('windows a long message’s quote on the word that matched, accents and case aside', async () => {
    await db.run(RUN_A);
    await db.item('long', {
      runId: RUN_A,
      payload: said(`${'filler '.repeat(60)}the Café opened`),
    });
    await db.ensureIndex();
    const { hits } = await service.search({
      query: 'cafe',
      limit: 30,
      includeArchived: true,
    });
    expect(hits[0]!.snippet).toContain('Café opened');
  });

  it('windows on a Greek word typed with its final sigma against uppercase text', async () => {
    await db.run(RUN_A);
    await db.item('greek', {
      runId: RUN_A,
      // `İ` lowercases to two characters, which rules the plain lowercase
      // search out — so the fold is what has to match the typed final ς to
      // the stored Σ.
      payload: said(`İstanbul ${'filler '.repeat(60)}ΟΔΟΣ ΚΛΕΙΣΤΗ`),
    });
    await db.ensureIndex();
    const { hits } = await service.search({
      query: 'οδος',
      limit: 30,
      includeArchived: true,
    });
    expect(hits[0]!.snippet).toContain('ΟΔΟΣ ΚΛΕΙΣΤΗ');
  });

  it('keeps its place across Hangul, whose syllables the fold leaves as they are', async () => {
    await db.run(RUN_A);
    // Each syllable decomposes into two or three jamo; folded as such, every
    // offset after them would point past the accented match the fold finds.
    await db.item('korean', {
      runId: RUN_A,
      payload: said(`${'한국어 '.repeat(80)}the Café opened`),
    });
    await db.ensureIndex();
    const { hits } = await service.search({
      query: 'cafe',
      limit: 30,
      includeArchived: true,
    });
    expect(hits[0]!.snippet).toContain('Café opened');
    expect(hits[0]!.snippet.startsWith('…')).toBe(true);
  });

  it('says when there were more matches than the limit', async () => {
    await db.run(RUN_A);
    for (let seq = 1; seq <= 3; seq++) {
      await db.item(`m${seq}`, { runId: RUN_A, seq, payload: said('same') });
    }
    await db.ensureIndex();
    const capped = await service.search({
      query: 'same',
      limit: 2,
      includeArchived: true,
    });
    expect(capped.hits).toHaveLength(2);
    expect(capped.partialReason).toContain('best 2');
  });

  it('answers no hits for a query with nothing searchable in it', async () => {
    await db.ensureIndex();
    expect(
      await service.search({
        query: '-- ??',
        limit: 30,
        includeArchived: true,
      }),
    ).toEqual({ hits: [], partialReason: null });
  });

  it('reads the conversation around a hit in order, marking it and cutting long text', async () => {
    await db.run(RUN_A, { title: 'Billing' });
    await db.item('m1', { runId: RUN_A, seq: 1, payload: said('one') });
    await db.item('m2', { runId: RUN_A, seq: 2, payload: said('two') });
    await db.item('t3', {
      runId: RUN_A,
      seq: 3,
      kind: 'tool_call',
      payload: JSON.stringify({ name: 'Bash' }),
    });
    await db.item('m4', {
      runId: RUN_A,
      seq: 4,
      role: 'assistant',
      payload: said('x'.repeat(MAX_CONTEXT_ITEM_CHARS + 5)),
    });
    await db.item('m5', { runId: RUN_A, seq: 5, payload: said('five') });

    const result = await service.context({
      runId: RUN_A,
      itemId: 'm4',
      before: 1,
      after: 3,
    });
    expect(result).toMatchObject({ runId: RUN_A, title: 'Billing' });
    expect(result.items.map((item) => [item.itemId, item.target])).toEqual([
      ['m2', false],
      ['m4', true],
      ['m5', false],
    ]);
    const target = result.items[1]!;
    expect(target.text).toHaveLength(MAX_CONTEXT_ITEM_CHARS);
    expect(target.truncated).toBe(true);
    expect(result.items[0]).toMatchObject({ text: 'two', truncated: false });
  });

  it('refuses a context read for anything a search could not have returned', async () => {
    await db.run(RUN_A);
    await db.run(RUN_GONE, { deletedAt: new Date() });
    await db.run(RUN_BUILDER, { editsWorkflowSlug: 'dev-team' });
    await db.item('tool', { runId: RUN_A, kind: 'tool_result' });
    await db.item('gone', { runId: RUN_GONE });
    await db.item('builder', { runId: RUN_BUILDER });
    for (const [runId, itemId] of [
      [RUN_A, 'nope'],
      [RUN_A, 'tool'],
      [RUN_GONE, 'gone'],
      [RUN_BUILDER, 'builder'],
      ['00000000-0000-4000-8000-0000000000ff', 'nope'],
    ] as const) {
      await expect(
        service.context({ runId, itemId, before: 3, after: 3 }),
        `${runId}/${itemId}`,
      ).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('skips a soft-deleted neighbour', async () => {
    await db.run(RUN_A);
    await db.item('m1', { runId: RUN_A, seq: 1 });
    await db.item('m2', { runId: RUN_A, seq: 2, deletedAt: new Date() });
    await db.item('m3', { runId: RUN_A, seq: 3 });
    const { items } = await service.context({
      runId: RUN_A,
      itemId: 'm3',
      before: 5,
      after: 0,
    });
    expect(items.map((item) => item.itemId)).toEqual(['m1', 'm3']);
  });

  describe('with a registered secret', () => {
    const secret = 'sk-live-0123456789abcdefghij';

    beforeEach(() => {
      registerSecret(secret, 'spec key');
    });

    afterEach(() => {
      clearSecrets();
    });

    it('redacts it from what a search and a context read hand back', async () => {
      await db.run(RUN_A);
      await db.item('leak', {
        runId: RUN_A,
        payload: said(`deploy with token ${secret} today`),
      });
      await db.ensureIndex();
      const { hits } = await service.search({
        query: 'deploy',
        limit: 30,
        includeArchived: true,
      });
      const { items } = await service.context({
        runId: RUN_A,
        itemId: 'leak',
        before: 0,
        after: 0,
      });
      expect(hits[0]!.snippet).not.toContain(secret);
      expect(items[0]!.text).not.toContain(secret);
      expect(items[0]!.text).toContain('deploy with token');
    });

    it('redacts a context read before cutting it, so the cut shows no fragment', async () => {
      await db.run(RUN_A);
      await db.item('edge', {
        runId: RUN_A,
        payload: said(
          `${'x'.repeat(MAX_CONTEXT_ITEM_CHARS - 7)}${secret} tail`,
        ),
      });
      const { items } = await service.context({
        runId: RUN_A,
        itemId: 'edge',
        before: 0,
        after: 0,
      });
      expect(items[0]!.text).not.toContain('sk-live');
    });

    it('redacts before cutting, so a snippet edge inside it shows no fragment', async () => {
      await db.run(RUN_A);
      // The quote is a 240-character window from the start; the secret
      // begins 7 characters before its end.
      await db.item('edge', {
        runId: RUN_A,
        payload: said(`deploy ${'w '.repeat(113)}${secret} tail`),
      });
      await db.ensureIndex();
      const { hits } = await service.search({
        query: 'deploy',
        limit: 30,
        includeArchived: true,
      });
      expect(hits[0]!.snippet).not.toContain('sk-live');
    });
  });
});
