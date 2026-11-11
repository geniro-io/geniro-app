import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Project } from '../../projects/entity/project.entity';
import type { RunPlace } from '../../projects/projects.types';
import { AgentKind } from '../../runs/runs.types';
import { make, memoryDb } from '../__tests__/memory-db';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryActor,
  type MemoryEntry,
} from '../memory.types';
import { memoryTextHash, orderedPair } from '../utils/memory-pairs';

const USER: MemoryActor = { kind: 'user' };
const NONE: RunPlace = { projectId: null, teamSlug: null };
const inProject = (projectId: string): RunPlace => ({
  projectId,
  teamSlug: null,
});
const inTeam = (teamSlug: string): RunPlace => ({
  projectId: null,
  teamSlug,
});

describe('MemoryFindingsService', () => {
  let db: Awaited<ReturnType<typeof memoryDb>>;

  beforeEach(async () => {
    db = await memoryDb();
    db.service.setConfig(DEFAULT_MEMORY_CONFIG);
  });

  afterEach(async () => {
    await db.orm.close();
  });

  async function addProject(id: string) {
    const em = db.em.fork();
    em.persist(make(Project, { id, name: id, folder: `/repo/${id}` }));
    await em.flush();
  }

  async function save(
    title: string,
    place: RunPlace,
    body = 'Use pnpm for the workspace.',
    twin?: MemoryEntry,
  ): Promise<MemoryEntry> {
    const outcome = await db.service.save(
      USER,
      {
        title,
        body,
        ...(place.teamSlug === null ? {} : { scope: 'team' as const }),
        ...(twin === undefined ? {} : { notDuplicateOf: [twin.handle] }),
      },
      place,
    );
    if (outcome.kind !== 'created') {
      throw new Error(`expected a created entry, got ${outcome.kind}`);
    }
    return outcome.entry;
  }

  function expectOnePairOf(
    pairs: { aId: string; bId: string }[],
    first: MemoryEntry,
    second: MemoryEntry,
  ) {
    expect(pairs.map(({ aId, bId }) => [aId, bId])).toEqual([
      orderedPair(first.id, second.id),
    ]);
  }

  async function judge(first: MemoryEntry, second: MemoryEntry) {
    const [aId, bId] = orderedPair(first.id, second.id);
    const byId = new Map([first, second].map((entry) => [entry.id, entry]));
    const textA = byId.get(aId)!;
    const textB = byId.get(bId)!;
    const [finding] = await db.findings.record([
      {
        memoryAId: aId,
        memoryBId: bId,
        hashA: memoryTextHash(textA.title, textA.body),
        hashB: memoryTextHash(textB.title, textB.body),
        outcome: 'contradicts',
        quoteA: 'Use pnpm for the workspace',
        quoteB: 'Use pnpm for the workspace',
        reason: 'the same rule',
        agentKind: AgentKind.Claude,
        model: null,
      },
    ]);
    return finding!;
  }

  it('two entries of different projects are never paired', async () => {
    await addProject('p1');
    await addProject('p2');
    await save('Pnpm workspace rule', inProject('p1'));
    await save('Pnpm workspace rule', inProject('p2'));

    expect(await db.findings.candidatePairs()).toEqual([]);
  });

  it('a global entry and one of a project with the same text are paired', async () => {
    await addProject('p1');
    const global = await save('Pnpm workspace rule', NONE);
    const scoped = await save('Pnpm workspace rule', inProject('p1'));

    expectOnePairOf(await db.findings.candidatePairs(), global, scoped);
  });

  it('two entries of one project with the same text are paired', async () => {
    await addProject('p1');
    const first = await save('Pnpm workspace rule', inProject('p1'));
    const second = await save(
      'Pnpm workspace rule',
      inProject('p1'),
      undefined,
      first,
    );

    expectOnePairOf(await db.findings.candidatePairs(), first, second);
  });

  it('two entries of different teams are never paired', async () => {
    await save('Pnpm workspace rule', inTeam('t1'));
    await save('Pnpm workspace rule', inTeam('t2'));

    expect(await db.findings.candidatePairs()).toEqual([]);
  });

  it('a team entry and a project entry with the same text are never paired', async () => {
    await addProject('p1');
    await save('Pnpm workspace rule', inTeam('t1'));
    await save('Pnpm workspace rule', inProject('p1'));

    expect(await db.findings.candidatePairs()).toEqual([]);
  });

  it('a team entry and a global entry with the same text are paired', async () => {
    const global = await save('Pnpm workspace rule', NONE);
    const team = await save('Pnpm workspace rule', inTeam('t1'));

    expectOnePairOf(await db.findings.candidatePairs(), global, team);
  });

  it('Undo leaves a dismissed pair dismissed, and brings back a pair it had only hidden', async () => {
    const dismissedA = await save('Pnpm workspace rule', NONE);
    const dismissedB = await save(
      'Pnpm workspace rule',
      NONE,
      'Use pnpm.',
      dismissedA,
    );
    const shownA = await save('Colima restarts', NONE);
    const shownB = await save(
      'Colima restarts',
      NONE,
      'Restart colima.',
      shownA,
    );
    const dismissed = await judge(dismissedA, dismissedB);
    const shown = await judge(shownA, shownB);
    expect(await db.findings.dismiss(dismissed.id)).toBe(true);
    expect((await db.findings.open()).map((row) => row.id)).toEqual([shown.id]);

    const batch = await db.service.forgetBatch([dismissedB.id, shownB.id]);
    expect(await db.findings.open()).toEqual([]);
    await db.service.restoreBatch(batch.batchId!);

    expect((await db.findings.open()).map((row) => row.id)).toEqual([shown.id]);
  });

  it('a finding is hidden once either text changes', async () => {
    const first = await save('Pnpm workspace rule', NONE);
    const second = await save('Pnpm workspace rule', NONE, 'Use pnpm.', first);
    await judge(first, second);
    expect(await db.findings.open()).toHaveLength(1);

    const edited = await db.service.edit(second.id, {
      rev: second.rev,
      title: second.title,
      body: 'Use pnpm, always.',
      type: second.type,
      projectId: second.projectId,
      teamSlug: second.teamSlug,
      notDuplicateOf: [first.handle],
    });

    expect(edited.kind).toBe('updated');
    expect(await db.findings.open()).toEqual([]);
  });
});
