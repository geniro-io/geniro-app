import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../dao/run.dao';
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

function deps(holding: string[]): {
  service: PullRequestRecaptureService;
  forgotten: string[];
  listWithPullRequests: ReturnType<typeof vi.fn>;
  marker: string;
} {
  const forgotten: string[] = [];
  // The DAO filters `pullRequests: { $ne: null }` in SQL, so the double answers
  // with the holding rows alone.
  const listWithPullRequests = vi.fn(async () => holding.map((id) => ({ id })));
  const runDao = {
    listWithPullRequests,
    forgetPullRequestCapture: async (runId: string) => {
      forgotten.push(runId);
    },
  } as unknown as RunDao;
  const marker = markerPath();
  return {
    service: new PullRequestRecaptureService(runDao, em, marker),
    forgotten,
    listWithPullRequests,
    marker,
  };
}

describe('PullRequestRecaptureService', () => {
  it('forgets the captured list of every run holding one, and nothing else', async () => {
    const { service, forgotten } = deps(['run-a', 'run-c']);

    await expect(service.recapture()).resolves.toBe(2);
    expect(forgotten).toEqual(['run-a', 'run-c']);
  });

  it('RETIRES itself — a second launch reads nothing and resets nothing', async () => {
    // Run every launch, it would discard the capture's marker each time and
    // have every first listing re-read those runs' whole transcripts.
    const { service, forgotten, listWithPullRequests, marker } = deps([
      'run-a',
    ]);
    await expect(service.recapture()).resolves.toBe(1);

    // A whole new process, same userData.
    const runDao = {
      listWithPullRequests,
      forgetPullRequestCapture: async (runId: string) => {
        forgotten.push(runId);
      },
    } as unknown as RunDao;
    const second = new PullRequestRecaptureService(runDao, em, marker);
    await expect(second.recapture()).resolves.toBeNull();

    expect(listWithPullRequests).toHaveBeenCalledTimes(1);
    expect(forgotten).toEqual(['run-a']);
  });

  it('retires on a fresh install too, where it found nothing to do', async () => {
    const { service, listWithPullRequests, marker } = deps([]);
    await expect(service.recapture()).resolves.toBe(0);

    const second = new PullRequestRecaptureService(
      { listWithPullRequests } as unknown as RunDao,
      em,
      marker,
    );
    await expect(second.recapture()).resolves.toBeNull();
    expect(listWithPullRequests).toHaveBeenCalledTimes(1);
  });

  it('does NOT retire when the marker could not be written', async () => {
    // The resets have landed, so a failed marker write must not fail the boot;
    // what it costs is one more sweep next launch, which is the safe direction.
    const forgotten: string[] = [];
    const listWithPullRequests = vi.fn(async () => [{ id: 'run-a' }]);
    const runDao = {
      listWithPullRequests,
      forgetPullRequestCapture: async (runId: string) => {
        forgotten.push(runId);
      },
    } as unknown as RunDao;
    // A path whose PARENT does not exist: the write throws, nothing is recorded.
    const unwritable = join(markerPath(), 'no-such-dir', 'marker');
    const make = (): PullRequestRecaptureService =>
      new PullRequestRecaptureService(runDao, em, unwritable);

    await expect(make().recapture()).resolves.toBe(1);
    await expect(make().recapture()).resolves.toBe(1);
    expect(listWithPullRequests).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure so the daemon still starts', async () => {
    const runDao = {
      listWithPullRequests: async () => {
        throw new Error('database is locked');
      },
    } as unknown as RunDao;
    const service = new PullRequestRecaptureService(runDao, em, markerPath());

    await expect(service.recaptureQuietly()).resolves.toBeUndefined();
  });
});
