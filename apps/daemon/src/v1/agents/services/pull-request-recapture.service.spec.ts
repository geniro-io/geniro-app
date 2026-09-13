import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../dao/run.dao';
import type { PullRequestCaptureService } from './pull-request-capture.service';
import { PullRequestRecaptureService } from './pull-request-recapture.service';

const em = { fork: () => em } as unknown as EntityManager;

/**
 * A fresh userData for each service, so the completion marker one test writes
 * cannot retire the migration for the next.
 */
const dirs: string[] = [];
function markerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'geniro-recapture-'));
  dirs.push(dir);
  return join(dir, 'pull-requests-recaptured');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Doubles {
  runDao: RunDao;
  capture: PullRequestCaptureService;
  forgotten: string[];
  listWithPullRequests: ReturnType<typeof vi.fn>;
  getAll: ReturnType<typeof vi.fn>;
  sync: ReturnType<typeof vi.fn>;
}

function doubles(holding: string[]): Doubles {
  const forgotten: string[] = [];
  // The DAO filters `pullRequests: { $ne: null }` in SQL, so the double answers
  // with the holding rows alone.
  const listWithPullRequests = vi.fn(async () => holding.map((id) => ({ id })));
  const getAll = vi.fn(async (where: { id: { $in: string[] } }) =>
    where.id.$in.map((id) => ({ id, pullRequests: null })),
  );
  const sync = vi.fn(async () => undefined);
  return {
    runDao: {
      listWithPullRequests,
      getAll,
      forgetPullRequestCapture: async (runId: string) => {
        forgotten.push(runId);
      },
    } as unknown as RunDao,
    capture: { sync } as unknown as PullRequestCaptureService,
    forgotten,
    listWithPullRequests,
    getAll,
    sync,
  };
}

function service(
  d: Doubles,
  marker = markerPath(),
): PullRequestRecaptureService {
  return new PullRequestRecaptureService(d.runDao, d.capture, em, marker);
}

describe('PullRequestRecaptureService', () => {
  it('forgets the captured list of every run holding one, and nothing else', async () => {
    const d = doubles(['run-a', 'run-c']);

    await expect(service(d).recapture()).resolves.toBe(2);
    expect(d.forgotten).toEqual(['run-a', 'run-c']);
  });

  it('RETIRES itself — a second launch reads nothing and resets nothing', async () => {
    // Run every launch, it would discard the capture's marker each time and
    // have every first listing re-read those runs' whole transcripts.
    const d = doubles(['run-a']);
    const marker = markerPath();
    await expect(service(d, marker).recapture()).resolves.toBe(1);

    // A whole new process, same userData.
    await expect(service(d, marker).recapture()).resolves.toBeNull();

    expect(d.listWithPullRequests).toHaveBeenCalledTimes(1);
    expect(d.forgotten).toEqual(['run-a']);
  });

  it('retires on a fresh install too, where it found nothing to do', async () => {
    const d = doubles([]);
    const marker = markerPath();
    await expect(service(d, marker).recapture()).resolves.toBe(0);
    await expect(service(d, marker).recapture()).resolves.toBeNull();
    expect(d.listWithPullRequests).toHaveBeenCalledTimes(1);
  });

  it('does NOT retire when the marker could not be written', async () => {
    // The resets have landed, so a failed marker write must not fail the boot;
    // what it costs is one more sweep next launch, which is the safe direction.
    const d = doubles(['run-a']);
    // A path whose PARENT does not exist: the write throws, nothing is recorded.
    const unwritable = join(markerPath(), 'no-such-dir', 'marker');

    await expect(service(d, unwritable).recapture()).resolves.toBe(1);
    await expect(service(d, unwritable).recapture()).resolves.toBe(1);
    expect(d.listWithPullRequests).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure so the daemon still starts', async () => {
    const d = doubles([]);
    d.listWithPullRequests.mockRejectedValueOnce(
      new Error('database is locked'),
    );

    await expect(service(d).recaptureQuietly()).resolves.toBeUndefined();
  });

  it('captures the runs it reset again, without waiting for a listing to show them', async () => {
    // REVIEWED: a listing captures only the runs in its scope, so an ARCHIVED
    // run stayed empty until someone opened the archive — and the merge
    // automation reads the column directly, so its card never moved to done.
    const d = doubles(['run-a', 'run-archived']);
    const s = service(d);
    await s.recapture();

    await expect(s.recaptureResetRuns()).resolves.toBe(2);
    expect(d.getAll).toHaveBeenCalledWith(
      { id: { $in: ['run-a', 'run-archived'] } },
      undefined,
      em,
    );
    expect(d.sync).toHaveBeenCalledTimes(1);
    expect(d.sync).toHaveBeenCalledWith(
      [
        { id: 'run-a', pullRequests: null },
        { id: 'run-archived', pullRequests: null },
      ],
      em,
    );

    // Once: a second call has nothing left to capture.
    await expect(s.recaptureResetRuns()).resolves.toBe(0);
    expect(d.sync).toHaveBeenCalledTimes(1);
  });

  it('captures nothing when this launch reset nothing, or the migration had already run', async () => {
    const empty = doubles([]);
    const fresh = service(empty);
    await fresh.recapture();
    await expect(fresh.recaptureResetRuns()).resolves.toBe(0);

    const d = doubles(['run-a']);
    const marker = markerPath();
    await service(d, marker).recapture();
    const retired = service(d, marker);
    await retired.recapture();
    await expect(retired.recaptureResetRuns()).resolves.toBe(0);

    expect(empty.sync).not.toHaveBeenCalled();
    expect(d.sync).not.toHaveBeenCalled();
  });

  it('the background capture swallows its failure — the next listing reads those runs instead', async () => {
    const d = doubles(['run-a']);
    d.sync.mockRejectedValueOnce(new Error('disk gone'));
    const s = service(d);
    await s.recapture();

    await expect(s.recaptureResetRunsQuietly()).resolves.toBeUndefined();
    expect(d.sync).toHaveBeenCalledTimes(1);
  });
});
