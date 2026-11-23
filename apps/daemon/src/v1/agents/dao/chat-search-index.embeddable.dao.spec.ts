import type { MikroORM } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { chatSearchDb, said } from '../__tests__/chat-search-db';

const RUN_A = '00000000-0000-4000-8000-00000000000a';
const RUN_B = '00000000-0000-4000-8000-0000000000b0';
const RUN_ARCHIVED = '00000000-0000-4000-8000-00000000000c';
const RUN_DELETED = '00000000-0000-4000-8000-00000000000d';
const RUN_BUILDER = '00000000-0000-4000-8000-00000000000e';
const RUN_ANALYSIS = '00000000-0000-4000-8000-00000000000f';
const RUN_SYSTEM = '00000000-0000-4000-8000-0000000000a0';
const NOW = new Date('2026-01-01T00:00:00Z');

describe('ChatSearchIndexDao embeddings reads', () => {
  let db: Awaited<ReturnType<typeof chatSearchDb>>;
  let orm: MikroORM;

  beforeEach(async () => {
    db = await chatSearchDb();
    orm = db.orm;
    await db.run(RUN_A, { title: 'Billing', cwd: '/shop' });
    await db.run(RUN_B, { title: 'Other', cwd: '/other' });
    await db.run(RUN_ARCHIVED, { title: 'Old', archivedAt: NOW });
    await db.run(RUN_DELETED, { title: 'Gone', deletedAt: NOW });
    await db.run(RUN_BUILDER, { title: 'Builder', editsTeamSlug: 'team-x' });
    await db.run(RUN_ANALYSIS, {
      title: 'Analysis',
      analysisSourceRunId: RUN_A,
      analysisPurpose: 'review',
    });
    await db.run(RUN_SYSTEM, { title: 'System', analysisPurpose: 'system' });

    await db.item('user-a', {
      runId: RUN_A,
      seq: 1,
      payload: said('Billing question'),
    });
    await db.item('assistant-a', {
      runId: RUN_A,
      seq: 2,
      role: 'assistant',
      payload: said('Billing answer'),
    });
    await db.item('reason-a', {
      runId: RUN_A,
      seq: 3,
      kind: 'reasoning',
      role: 'assistant',
      payload: said('Billing reasoning'),
    });
    await db.item('deleted-a', {
      runId: RUN_A,
      seq: 4,
      payload: said('Billing deleted'),
      deletedAt: NOW,
    });
    await db.item('archived-a', {
      runId: RUN_ARCHIVED,
      seq: 1,
      payload: said('Billing archived'),
    });
    await db.item('gone-a', {
      runId: RUN_DELETED,
      seq: 1,
      payload: said('Billing gone'),
    });
    await db.item('builder-a', {
      runId: RUN_BUILDER,
      seq: 1,
      payload: said('Billing builder'),
    });
    await db.item('analysis-a', {
      runId: RUN_ANALYSIS,
      seq: 1,
      payload: said('Billing analysis'),
    });
    await db.item('system-a', {
      runId: RUN_SYSTEM,
      seq: 1,
      payload: said('Billing system'),
    });
    await db.item('user-b', {
      runId: RUN_B,
      seq: 1,
      payload: said('Billing elsewhere'),
    });
    await db.ensureIndex();
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it('lists the user and assistant messages to embed, archived chats included, in order', async () => {
    const rows = await db.dao().embeddableRows(0, 'after', 100);

    expect(rows.map((row) => row.id)).toEqual([
      'user-a',
      'assistant-a',
      'archived-a',
      'user-b',
    ]);
    expect(rows[0]).toMatchObject({ run_id: RUN_A, text: 'Billing question' });
    expect(await db.dao().embeddableCount()).toBe(4);
  });

  it('walks back from a rowid newest first, and honours the limit', async () => {
    const all = await db.dao().embeddableRows(0, 'after', 100);
    const newest = all.at(-1)?.rowid ?? 0;

    const older = await db.dao().embeddableRows(newest, 'before', 2);

    expect(older.map((row) => row.id)).toEqual(['archived-a', 'assistant-a']);
  });

  it('answers the hits among the ids it is given, under the search filters', async () => {
    const ids = ['user-a', 'user-b', 'archived-a', 'builder-a', 'gone-a'];
    const dao = db.dao();

    const live = await dao.hitsAmong({ includeArchived: false }, ids);
    const everything = await dao.hitsAmong({ includeArchived: true }, ids);
    const inRunA = await dao.hitsAmong(
      { includeArchived: true, runId: RUN_A },
      ids,
    );

    expect(live.map((row) => row.id).sort()).toEqual(['user-a', 'user-b']);
    expect(everything.map((row) => row.id).sort()).toEqual([
      'archived-a',
      'user-a',
      'user-b',
    ]);
    expect(inRunA.map((row) => row.id)).toEqual(['user-a']);
    expect(await dao.hitsAmong({ includeArchived: true }, [])).toEqual([]);
  });

  it('reaches only the runs a search may return, archived ones with includeArchived', async () => {
    const dao = db.dao();

    expect(
      (await dao.reachableRunIds({ includeArchived: false })).sort(),
    ).toEqual([RUN_A, RUN_B].sort());
    expect(
      (await dao.reachableRunIds({ includeArchived: true })).sort(),
    ).toEqual([RUN_A, RUN_ARCHIVED, RUN_B].sort());
  });
});
