import { BadRequestException } from '@packages/common';
import { Subject } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type {
  BackgroundJob,
  BackgroundJobSource,
} from '../background-jobs.types';
import { BackgroundJobsRegistry } from './background-jobs.registry';

function job(
  id: string,
  startedAt: string,
  status: BackgroundJob['status'] = 'done',
): BackgroundJob {
  return {
    id,
    kind: 'lessons',
    status,
    phase: null,
    runId: null,
    title: null,
    startedAt,
    endedAt: null,
    model: null,
    costUsd: null,
    durationMs: null,
    error: null,
    lessons: null,
  };
}

function source(
  active: BackgroundJob[],
  finished: BackgroundJob[],
): BackgroundJobSource & { changed: Subject<void> } {
  const changed = new Subject<void>();
  return {
    kind: 'lessons',
    changed,
    active: () => Promise.resolve(active),
    finished: ({ notAfter, limit }) =>
      Promise.resolve(
        finished
          .filter(
            (item) =>
              notAfter === null || Date.parse(item.startedAt) <= +notAfter,
          )
          .slice(0, limit),
      ),
    changes: () => changed.asObservable(),
  };
}

describe('BackgroundJobsRegistry', () => {
  it('lists running jobs before queued ones and counts every active job', async () => {
    const registry = new BackgroundJobsRegistry();
    registry.register(
      source(
        [
          job('q', '2026-11-22T10:05:00.000Z', 'queued'),
          job('r', '2026-11-22T10:00:00.000Z', 'running'),
        ],
        [],
      ),
    );

    const list = await registry.list({ limit: 5 });

    expect(list.active.map((item) => item.id)).toEqual(['r', 'q']);
    expect(list.running).toBe(2);
  });

  it('pages finished jobs newest first and continues from the cursor without repeats', async () => {
    const registry = new BackgroundJobsRegistry();
    registry.register(
      source(
        [],
        [
          job('d', '2026-11-22T12:00:00.000Z'),
          job('c', '2026-11-22T11:00:00.000Z'),
          job('b', '2026-11-22T11:00:00.000Z'),
          job('a', '2026-11-22T09:00:00.000Z'),
        ],
      ),
    );

    const first = await registry.list({ limit: 2 });
    expect(first.finished.map((item) => item.id)).toEqual(['d', 'c']);
    expect(first.nextBefore).not.toBeNull();

    const second = await registry.list({
      limit: 2,
      before: first.nextBefore ?? undefined,
    });
    expect(second.finished.map((item) => item.id)).toEqual(['b', 'a']);
    expect(second.nextBefore).toBeNull();
  });

  it('refuses a cursor it did not hand out', async () => {
    const registry = new BackgroundJobsRegistry();

    await expect(registry.list({ limit: 2, before: 'nope' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('announces a change of any source by its kind', () => {
    const registry = new BackgroundJobsRegistry();
    const lessons = source([], []);
    registry.register(lessons);
    const seen: string[] = [];
    registry.allChanges().subscribe((change) => seen.push(change.kind));

    lessons.changed.next();

    expect(seen).toEqual(['lessons']);
  });

  it('refuses a second source of the same kind', () => {
    const registry = new BackgroundJobsRegistry();
    registry.register(source([], []));

    expect(() => registry.register(source([], []))).toThrow(/twice/);
  });
});
