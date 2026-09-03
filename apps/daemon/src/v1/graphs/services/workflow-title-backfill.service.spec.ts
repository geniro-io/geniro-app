import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { Run } from '../../runs/entity/run.entity';
import type { WorkflowSummary } from '../graphs.types';
import type { WorkflowStoreService } from './workflow-store.service';
import { WorkflowTitleBackfillService } from './workflow-title-backfill.service';

const em = { fork: () => em } as unknown as EntityManager;

/**
 * A fresh userData for each service, so the completion marker one test writes
 * cannot retire the migration for the next.
 */
const dirs: string[] = [];
function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'geniro-backfill-'));
  dirs.push(dir);
  return join(dir, 'workflow-titles-backfilled');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(overrides: Partial<Run>): Run {
  return {
    id: 'run-1',
    workflowId: 'dev-team',
    title: null,
    ...overrides,
  } as Run;
}

function summary(slug: string, name: string): WorkflowSummary {
  return { slug, name } as WorkflowSummary;
}

function deps(
  runs: Run[],
  workflows: WorkflowSummary[],
): {
  service: WorkflowTitleBackfillService;
  cleared: { runId: string; expected: string }[];
  marker: string;
} {
  const cleared: { runId: string; expected: string }[] = [];
  const runDao = {
    // The DAO filters `title: { $ne: null }` in SQL, so the double answers with
    // the titled rows alone — a fake that returned untitled ones too would let
    // an assertion pass on a filter the query no longer performs.
    listTitledWorkflowRuns: async () => runs.filter((r) => r.title !== null),
    forgetTitle: async (runId: string, expected: string) => {
      cleared.push({ runId, expected });
      return true;
    },
  } as unknown as RunDao;
  const store = {
    list: async () => workflows,
  } as unknown as WorkflowStoreService;
  const marker = markerPath();
  return {
    service: new WorkflowTitleBackfillService(runDao, store, em, marker),
    cleared,
    marker,
  };
}

describe('WorkflowTitleBackfillService', () => {
  it('clears a title that only repeats its own workflow name', async () => {
    const { service, cleared } = deps(
      [run({ title: 'Dev Team' })],
      [summary('dev-team', 'Dev Team')],
    );

    await expect(service.backfill()).resolves.toBe(1);
    expect(cleared).toEqual([{ runId: 'run-1', expected: 'Dev Team' }]);
  });

  it('leaves a title the user or the derivation wrote', async () => {
    const { service, cleared } = deps(
      [run({ title: 'Fix the archive sweep' })],
      [summary('dev-team', 'Dev Team')],
    );

    await expect(service.backfill()).resolves.toBe(0);
    expect(cleared).toEqual([]);
  });

  it('leaves a title matching a DIFFERENT workflow name', async () => {
    // The stamp only ever wrote the run's OWN workflow name, so a title that
    // matches a sibling's is a coincidence — or a rename — and erasing it would
    // destroy a name on a guess.
    const { service, cleared } = deps(
      [run({ title: 'Reviewers' })],
      [summary('dev-team', 'Dev Team'), summary('reviewers', 'Reviewers')],
    );

    await expect(service.backfill()).resolves.toBe(0);
    expect(cleared).toEqual([]);
  });

  it('leaves a run whose workflow has since been renamed', async () => {
    const { service, cleared } = deps(
      [run({ title: 'Dev Team' })],
      [summary('dev-team', 'Dev Team v2')],
    );

    await expect(service.backfill()).resolves.toBe(0);
    expect(cleared).toEqual([]);
  });

  it('leaves an already-unnamed run alone', async () => {
    const { service, cleared } = deps(
      [run({ title: null })],
      [summary('dev-team', 'Dev Team')],
    );

    await expect(service.backfill()).resolves.toBe(0);
    expect(cleared).toEqual([]);
  });

  it('does not count a run whose title changed under it', async () => {
    // `forgetTitle` compares before it writes, so a rename landing between the
    // read and the write wins and the sweep must not report it as cleared.
    const runDao = {
      listTitledWorkflowRuns: async () => [run({ title: 'Dev Team' })],
      forgetTitle: async () => false,
    } as unknown as RunDao;
    const store = {
      list: async () => [summary('dev-team', 'Dev Team')],
    } as unknown as WorkflowStoreService;

    const service = new WorkflowTitleBackfillService(
      runDao,
      store,
      em,
      markerPath(),
    );

    await expect(service.backfill()).resolves.toBe(0);
  });

  it('asks the library nothing when there are no workflow runs', async () => {
    const list = vi.fn(async () => [] as WorkflowSummary[]);
    const runDao = {
      listTitledWorkflowRuns: async () => [],
      forgetTitle: async () => true,
    } as unknown as RunDao;

    const service = new WorkflowTitleBackfillService(
      runDao,
      { list } as unknown as WorkflowStoreService,
      em,
      markerPath(),
    );

    await expect(service.backfill()).resolves.toBe(0);
    expect(list).not.toHaveBeenCalled();
  });

  it('swallows a failure so the daemon still starts', async () => {
    const runDao = {
      listTitledWorkflowRuns: async () => {
        throw new Error('database is locked');
      },
    } as unknown as RunDao;
    const store = {
      list: async () => [],
    } as unknown as WorkflowStoreService;

    const service = new WorkflowTitleBackfillService(
      runDao,
      store,
      em,
      markerPath(),
    );

    await expect(service.backfillQuietly()).resolves.toBeUndefined();
  });

  it('RETIRES itself — a second launch reads nothing and clears nothing', async () => {
    // Without this the migration is a permanent rule: a user can rename a
    // workflow run to exactly its workflow's name, which the predicate cannot
    // tell from the executor's old stamp, and every later boot would erase it.
    const listTitledWorkflowRuns = vi.fn(async () => [
      run({ title: 'Dev Team' }),
    ]);
    const runDao = {
      listTitledWorkflowRuns,
      forgetTitle: async () => true,
    } as unknown as RunDao;
    const store = {
      list: async () => [summary('dev-team', 'Dev Team')],
    } as unknown as WorkflowStoreService;
    const marker = markerPath();

    const first = new WorkflowTitleBackfillService(runDao, store, em, marker);
    await expect(first.backfill()).resolves.toBe(1);

    // A whole new process, same userData.
    const second = new WorkflowTitleBackfillService(runDao, store, em, marker);
    await expect(second.backfill()).resolves.toBeNull();

    expect(listTitledWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it('retires on a fresh install too, where it found nothing to do', async () => {
    // A run that HAPPENED and cleared nothing is as finished as one that
    // cleared a row — otherwise every new install re-scans for the life of the
    // app.
    const listTitledWorkflowRuns = vi.fn(async () => [] as Run[]);
    const marker = markerPath();
    const make = (): WorkflowTitleBackfillService =>
      new WorkflowTitleBackfillService(
        { listTitledWorkflowRuns } as unknown as RunDao,
        { list: async () => [] } as unknown as WorkflowStoreService,
        em,
        marker,
      );

    await expect(make().backfill()).resolves.toBe(0);
    await expect(make().backfill()).resolves.toBeNull();

    expect(listTitledWorkflowRuns).toHaveBeenCalledTimes(1);
  });

  it('does NOT retire when the marker could not be written', async () => {
    // The repair has already landed, so a failed marker write must not fail the
    // boot. What it costs is one more scan next launch, which is the safe
    // direction — the alternative is a migration that believes it is done.
    const listTitledWorkflowRuns = vi.fn(async () => [
      run({ title: 'Dev Team' }),
    ]);
    // A path whose PARENT does not exist: the write throws, nothing is recorded.
    const unwritable = join(markerPath(), 'no-such-dir', 'marker');
    const make = (): WorkflowTitleBackfillService =>
      new WorkflowTitleBackfillService(
        {
          listTitledWorkflowRuns,
          forgetTitle: async () => true,
        } as unknown as RunDao,
        {
          list: async () => [summary('dev-team', 'Dev Team')],
        } as unknown as WorkflowStoreService,
        em,
        unwritable,
      );

    await expect(make().backfill()).resolves.toBe(1);
    // Not retired — the next launch tries again rather than skipping for good.
    await expect(make().backfill()).resolves.toBe(1);
    expect(listTitledWorkflowRuns).toHaveBeenCalledTimes(2);
  });
});
