import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import {
  asEmbeddingIndex,
  FakeEmbeddingIndex,
} from '../../embeddings/__tests__/fake-embedding-index';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { RunPlace } from '../../projects/projects.types';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { TaskDao } from '../../tasks/dao/task.dao';
import { memoryDb } from '../__tests__/memory-db';
import { MemoryDao } from '../dao/memory.dao';
import { MemoryReviewFindingDao } from '../dao/memory-review-finding.dao';
import type { MemoryActor, MemorySaveOutcome } from '../memory.types';
import { MemoryService } from './memory.service';

type Db = Awaited<ReturnType<typeof memoryDb>>;

const NONE: RunPlace = { projectId: null, teamSlug: null };
const AGENT: MemoryActor = {
  kind: 'agent',
  runId: 'run-a',
  agentKind: 'claude',
  model: 'opus',
};
const USER: MemoryActor = { kind: 'user' };

const PNPM = {
  title: 'Use pnpm workspace',
  body: 'Install packages with pnpm, never npm.',
};
const IMAGES = {
  title: 'Chat images need a path',
  body: 'Pasted screenshots must live at a path without spaces.',
};
const REBUILD = {
  title: 'Rebuild after upgrade',
  body: 'Rebuild native modules and relaunch the daemon after upgrading.',
};
const LOCKFILES = {
  title: 'Install notes',
  body: 'Keep pnpm lockfiles committed.',
};
const RUSSIAN_IMAGES = 'почему не открываются картинки в чате';

function savedId(outcome: MemorySaveOutcome): string {
  if (outcome.kind !== 'created' && outcome.kind !== 'updated') {
    throw new Error(`expected a saved entry, got ${JSON.stringify(outcome)}`);
  }
  return outcome.entry.id;
}

/** The same service as `memoryDb()` builds, with the embedding index it does not take. */
function meaningService(db: Db, fake: FakeEmbeddingIndex): MemoryService {
  const em = db.em;
  const roots = {
    rootsOf: async () => new Map(),
  } as unknown as ProjectRootsService;
  return new MemoryService(
    em,
    new MemoryDao(em),
    new RunDao(em),
    new NodeStateDao(em),
    new ProjectDao(em),
    new ProjectScopeService(em, new TaskDao(em), new ProjectDao(em), roots),
    db.events,
    db.usage,
    new MemoryReviewFindingDao(em),
    db.marks,
    asEmbeddingIndex(fake),
  );
}

describe('MemoryService.search by meaning', () => {
  let db: Db;
  let fake: FakeEmbeddingIndex;
  let meaning: MemoryService;
  let pnpm: string;
  let images: string;
  let rebuild: string;

  beforeEach(async () => {
    db = await memoryDb();
    fake = new FakeEmbeddingIndex();
    meaning = meaningService(db, fake);
    pnpm = savedId(await db.service.save(AGENT, PNPM, NONE));
    images = savedId(await db.service.save(AGENT, IMAGES, NONE));
    rebuild = savedId(await db.service.save(AGENT, REBUILD, NONE));
  });

  afterEach(async () => {
    await db.orm.close();
  });

  describe('falls back to the word search, byte for byte', () => {
    it.each(['pnpm', 'images path'])(
      'when search by meaning is off (%s)',
      async (query) => {
        const words = await db.service.search(query, NONE, 10);
        fake.enabled = false;

        const answered = await meaning.search(query, NONE, 10);

        expect(words.length).toBeGreaterThan(0);
        expect(JSON.stringify(answered)).toBe(JSON.stringify(words));
        expect(fake.scoreCalls).toEqual([]);
      },
    );

    it.each(['pnpm', 'images path'])(
      'when the child answers nothing (%s)',
      async (query) => {
        const words = await db.service.search(query, NONE, 10);
        fake.answerScores = () => null;

        const answered = await meaning.search(query, NONE, 10);

        expect(JSON.stringify(answered)).toBe(JSON.stringify(words));
        expect(fake.scoreCalls).toHaveLength(1);
      },
    );

    it.each(['pnpm', 'images path'])(
      'when the child fails (%s)',
      async (query) => {
        const words = await db.service.search(query, NONE, 10);
        fake.answerScores = () =>
          Promise.reject(new Error('the embedding process exited with code 3'));

        const answered = await meaning.search(query, NONE, 10);

        expect(JSON.stringify(answered)).toBe(JSON.stringify(words));
      },
    );
  });

  it("hands memory_search the index's note for memory, and none without an index", () => {
    const note =
      'Search by meaning is off for memory in Settings → Search, so only word matches are listed.';
    fake.notes = { memory: note };

    expect(meaning.meaningNote()).toBe(note);
    expect(db.service.meaningNote()).toBeNull();
  });

  it('finds an entry that shares no word with the query when its meaning matches', async () => {
    fake.answerScores = () => [{ sourceId: images, similarity: 0.8 }];
    expect(await db.service.search(RUSSIAN_IMAGES, NONE, 10)).toEqual([]);

    const hits = await meaning.search(RUSSIAN_IMAGES, NONE, 10);

    expect(hits.map((hit) => hit.id)).toEqual([images]);
    expect(fake.scoreCalls[0]).toMatchObject({
      source: 'memory',
      query: RUSSIAN_IMAGES,
      limit: 50,
    });
    expect(fake.scoreCalls[0]?.sourceIds).toEqual(
      expect.arrayContaining([pnpm, images, rebuild]),
    );
  });

  it('keeps an exact title match first when the meaning order agrees with it', async () => {
    const lockfiles = savedId(await db.service.save(AGENT, LOCKFILES, NONE));
    fake.answerScores = () => [
      { sourceId: pnpm, similarity: 0.9 },
      { sourceId: lockfiles, similarity: 0.85 },
    ];

    const hits = await meaning.search('pnpm', NONE, 10);

    expect(hits.map((hit) => hit.id)).toEqual([pnpm, lockfiles]);
  });

  it('enqueues every entry it writes, for search by meaning to index', async () => {
    const written = savedId(
      await meaning.save(
        AGENT,
        { title: 'Node version', body: 'Use Node 24 from the lockfile.' },
        NONE,
      ),
    );

    expect(fake.enqueued).toContainEqual({
      source: 'memory',
      sourceIds: [written],
    });
  });

  it('enqueues the entries an import wrote', async () => {
    const result = await meaning.importNotes([
      {
        key: 'k1',
        title: 'Imported rule',
        body: 'Keep commits small.',
        type: 'project',
        projectId: null,
        importedFrom: 'claude',
      },
    ]);
    const [imported] = await meaning.search('imported', NONE, 5);

    expect(result.imported).toBe(1);
    expect(fake.enqueued).toContainEqual({
      source: 'memory',
      sourceIds: [imported?.id],
    });
  });

  it('deletes the vectors of an entry it purges', async () => {
    await meaning.setStatus(USER, pnpm, 'forgotten');

    expect(await meaning.purge(pnpm)).toEqual({ id: pnpm, handle: 'm1' });
    expect(fake.deleted).toEqual([{ source: 'memory', sourceIds: [pnpm] }]);
  });
});
