import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
import { make, memoryDb } from '../__tests__/memory-db';
import { MemoryDao } from '../dao/memory.dao';
import { Memory } from '../entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryActor,
  type MemoryReviewPage,
  type MemoryReviewQuery,
  type MemorySaveInput,
  type MemorySaveOutcome,
} from '../memory.types';
import { usageDay } from '../utils/memory-usage-day';
import { MemoryReviewService } from './memory-review.service';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(Date.now() + 100 * DAY);
const daysBefore = (days: number) =>
  usageDay(new Date(NOW.getTime() - days * DAY));

const NONE: RunPlace = { projectId: null, teamSlug: null };
const inProject = (projectId: string): RunPlace => ({
  projectId,
  teamSlug: null,
});
const inTeam = (teamSlug: string): RunPlace => ({
  projectId: null,
  teamSlug,
});

const AGENT: MemoryActor = {
  kind: 'agent',
  runId: 'run-a',
  agentKind: 'claude',
  model: 'opus',
};
const USER: MemoryActor = { kind: 'user' };

function entryOf(outcome: MemorySaveOutcome) {
  if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry;
}

function titlesOf(page: MemoryReviewPage): string[] {
  return page.rows.map((row) => row.entry.title).sort();
}

function rowTitled(page: MemoryReviewPage, title: string) {
  const row = page.rows.find((candidate) => candidate.entry.title === title);
  if (!row) {
    throw new Error(`no row ${title}`);
  }
  return row;
}

describe('MemoryReviewService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;
  let review: MemoryReviewService;

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    review = new MemoryReviewService(
      db.em,
      new MemoryDao(db.em),
      new ProjectDao(db.em),
      db.usage,
    );
  });

  afterEach(async () => {
    await db.orm.close();
  });

  async function save(
    actor: MemoryActor,
    input: MemorySaveInput,
    place: RunPlace = NONE,
  ) {
    return entryOf(await db.service.save(actor, input, place));
  }

  async function addProject(id: string, folder: string) {
    const em = db.em.fork();
    em.persist(make(Project, { id, name: id, folder }));
    await em.flush();
  }

  async function use(memoryId: string, day: string, reads: number) {
    await db.usageDao.add([
      { memoryId, day, reads, searchHits: 0, indexShows: 0 },
    ]);
  }

  it('sorts and counts over every row, past the page', async () => {
    const plain = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const quiet = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    const reader3 = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    const reader1 = await save(AGENT, { title: 'Changelog format', body: 'x' });
    const reader5 = await save(AGENT, {
      title: 'Migration journal',
      body: 'x',
    });
    await use(reader3.id, daysBefore(100), 3);
    await use(reader1.id, daysBefore(120), 1);
    await use(reader5.id, daysBefore(150), 5);

    const first = await review.page({ limit: 2 }, NOW);
    const second = await review.page({ limit: 2, cursor: first.next! }, NOW);
    const third = await review.page({ limit: 2, cursor: second.next! }, NOW);

    expect([first.total, second.total, third.total]).toEqual([5, 5, 5]);
    expect([first.next, second.next, third.next]).toEqual(['2', '4', null]);
    const rows = [...first.rows, ...second.rows, ...third.rows];
    expect(rows.map((row) => row.usage.reads)).toEqual([0, 0, 1, 3, 5]);
    expect(rows.map((row) => row.entry.id).sort()).toEqual(
      [plain.id, quiet.id, reader3.id, reader1.id, reader5.id].sort(),
    );
    expect(third.rows.map((row) => row.entry.id)).toEqual([reader5.id]);
  });

  it('a read 100 days ago is cold, a read in the window is not', async () => {
    const cold = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const warm = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await use(cold.id, daysBefore(100), 1);
    await use(warm.id, daysBefore(10), 1);

    const page = await review.page({}, NOW);

    expect(page.rows.map((row) => row.entry.id)).toEqual([cold.id]);
    expect(page.rows[0]?.usage).toMatchObject({
      reads: 1,
      readsLast90Days: 0,
      lastReadAt: daysBefore(100),
    });
    expect((await review.summary(NOW)).proposed).toBe(1);
  });

  it('a kept entry never appears in the cold tab, shows in kept, and returns when unkept', async () => {
    const kept = await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    const plain = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await db.service.setKept(kept.id, true);

    const cold = await review.page({}, NOW);
    const keptTab = await review.page({ tab: 'kept' }, NOW);

    expect(cold.rows.map((row) => row.entry.id)).toEqual([plain.id]);
    expect(keptTab.rows.map((row) => row.entry.id)).toEqual([kept.id]);
    expect(keptTab.rows[0]?.keptAt).not.toBeNull();
    expect((await review.ids({}, NOW)).ids).toEqual([plain.id]);

    await db.service.setKept(kept.id, false);

    const unkept = await review.page({}, NOW);
    expect(unkept.rows.map((row) => row.entry.id).sort()).toEqual(
      [kept.id, plain.id].sort(),
    );
    expect((await review.page({ tab: 'kept' }, NOW)).total).toBe(0);
  });

  it('review/ids leaves warned rows out', async () => {
    await save(AGENT, {
      title: 'Correction note',
      body: 'x',
      type: 'feedback',
    });
    await save(AGENT, { title: 'About the user', body: 'x', type: 'user' });
    await save(USER, { title: 'Mine', body: 'x' });
    await save(AGENT, { title: 'Pnpm only', body: 'Never run npm here.' });
    const clean = await save(AGENT, { title: 'Colima restarts', body: 'x' });

    expect(await review.ids({}, NOW)).toEqual({
      ids: [clean.id],
      warnedSkipped: 4,
    });
    const page = await review.page({}, NOW);
    expect(
      Object.fromEntries(
        page.rows.map((row) => [row.entry.title, row.warning]),
      ),
    ).toEqual({
      'Correction note': 'feedback',
      'About the user': 'user',
      Mine: 'writtenByYou',
      'Pnpm only': 'statesLimit',
      'Colima restarts': null,
    });
  });

  it('an entry not swept yet counts as warned until the sweep reads it', async () => {
    const clean = await save(AGENT, { title: 'Colima restarts', body: 'x' });
    await db.em
      .fork()
      .nativeUpdate(Memory, { id: clean.id }, { statesRule: null });

    expect(
      rowTitled(await review.page({}, NOW), 'Colima restarts').warning,
    ).toBe('notChecked');
    expect(await review.ids({}, NOW)).toEqual({ ids: [], warnedSkipped: 1 });

    await review.sweepQuietly();

    expect(
      rowTitled(await review.page({}, NOW), 'Colima restarts').warning,
    ).toBeNull();
    expect(await review.ids({}, NOW)).toEqual({
      ids: [clean.id],
      warnedSkipped: 0,
    });
    const row = await db.em.fork().findOneOrFail(Memory, { id: clean.id });
    expect(row.statesRule).toBe(false);
  });

  it('filters by type, scope, warnings only/hide and reference gone', async () => {
    const root = tempDir('memory-review-root-');
    await addProject('p1', root);
    await save(
      AGENT,
      { title: 'Build entry', body: 'Build runs from apps/gone/build.ts.' },
      inProject('p1'),
    );
    await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await save(
      AGENT,
      { title: 'Team lint', body: 'x', scope: 'team' },
      inTeam('team-a'),
    );
    await save(AGENT, {
      title: 'Correction note',
      body: 'x',
      type: 'feedback',
    });
    await save(AGENT, {
      title: 'Changelog format',
      body: 'Never edit the changelog by hand.',
    });

    const titles = async (query: MemoryReviewQuery) =>
      titlesOf(await review.page(query, NOW));

    expect(await titles({ type: 'feedback' })).toEqual(['Correction note']);
    expect(await titles({ scope: 'global' })).toEqual([
      'Changelog format',
      'Correction note',
      'Loopback binding',
    ]);
    expect(await titles({ scope: 'project', projectId: 'p1' })).toEqual([
      'Build entry',
    ]);
    expect(await titles({ scope: 'team', teamSlug: 'team-a' })).toEqual([
      'Team lint',
    ]);
    expect(await titles({ warnings: 'only' })).toEqual([
      'Changelog format',
      'Correction note',
    ]);
    expect(await titles({ warnings: 'hide' })).toEqual([
      'Build entry',
      'Loopback binding',
      'Team lint',
    ]);
    const gone = await review.page({ referenceGone: 'true' }, NOW);
    expect(titlesOf(gone)).toEqual(['Build entry']);
    expect(rowTitled(gone, 'Build entry').referencesGone).toEqual([
      'apps/gone/build.ts',
    ]);
  });

  it('the age filter keeps young entries out and younger counts them', async () => {
    await save(AGENT, { title: 'Pnpm workspace', body: 'x' });
    await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await save(AGENT, { title: 'Colima restarts', body: 'x' });
    const now = new Date();

    const young = await review.page({}, now);

    expect(young).toMatchObject({ rows: [], total: 0, younger: 3 });
    expect(await review.summary(now)).toMatchObject({
      proposed: 0,
      younger: 3,
    });
    expect((await review.page({ minAgeDays: 0 }, now)).total).toBe(3);
    expect(await review.page({}, NOW)).toMatchObject({ total: 3, younger: 0 });
  });

  it('a denied folder is not reference gone', async () => {
    const root = tempDir('memory-review-denied-');
    const locked = join(root, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'inside.ts'), 'export {};\n');
    await addProject('p2', root);
    await save(
      AGENT,
      { title: 'Locked module', body: 'Lives in locked/inside.ts.' },
      inProject('p2'),
    );

    chmodSync(locked, 0o000);
    try {
      const page = await review.page({}, NOW);

      expect(rowTitled(page, 'Locked module').referencesGone).toEqual([]);
      expect((await review.page({ referenceGone: 'true' }, NOW)).total).toBe(0);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('a missing file is reference gone, and a missing project folder leaves nothing gone', async () => {
    const root = tempDir('memory-review-missing-');
    await addProject('p3', root);
    await addProject('p4', join(root, 'no-such-repo'));
    await save(
      AGENT,
      { title: 'Moved file', body: 'Lives in src/moved.ts.' },
      inProject('p3'),
    );
    await save(
      AGENT,
      { title: 'Detached repo', body: 'Lives in src/any.ts.' },
      inProject('p4'),
    );

    const page = await review.page({}, NOW);

    expect(rowTitled(page, 'Moved file').referencesGone).toEqual([
      'src/moved.ts',
    ]);
    expect(rowTitled(page, 'Detached repo').referencesGone).toEqual([]);
  });

  it('summary counts every row over its statuses, read and kept marks', async () => {
    const read = await save(USER, { title: 'Pnpm workspace', body: 'x' });
    await save(AGENT, { title: 'Edit rule', body: 'Never edit it.' });
    const kept = await save(AGENT, { title: 'Loopback binding', body: 'x' });
    await db.service.setKept(kept.id, true);
    db.service.setConfig({
      enabled: true,
      agentWrites: 'pending',
      nativeMemoryOff: false,
    });
    await save(AGENT, { title: 'Colima restarts', body: 'x' });
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
    const gone = await save(AGENT, { title: 'Changelog format', body: 'x' });
    const batch = await db.service.forgetBatch([gone.id]);
    await use(read.id, daysBefore(10), 2);

    expect(await review.summary(NOW)).toEqual({
      active: 3,
      pending: 1,
      read: 1,
      neverRead: 2,
      proposed: 2,
      proposedWithWarning: 1,
      younger: 0,
      kept: 1,
      forgotten: 1,
      minAgeDays: 14,
      countedSince: daysBefore(10),
      counting: true,
      lastBatch: {
        batchId: batch.batchId,
        count: 1,
        forgottenAt: expect.any(String),
      },
    });
    await db.usage.markBackfilled();
    expect((await review.summary(NOW)).counting).toBe(false);
  });
});
