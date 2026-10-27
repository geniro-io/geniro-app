import { describe, expect, it } from 'vitest';

import type { LineSnapshotRead } from '../stats.types';
import { ActivityFold, linesIncrements } from './activity-fold';

const at = (iso: string): Date => new Date(iso);

function snapshot(
  runId: string,
  iso: string,
  linesAdded: number | null,
  linesRemoved: number | null,
  partial: boolean | null = false,
): LineSnapshotRead {
  return {
    runId,
    lineKey: null,
    occurredAt: at(iso),
    linesAdded,
    linesRemoved,
    partial,
  };
}

describe('ActivityFold', () => {
  it('counts a thread that worked on two days once for the period and once on each day', () => {
    const fold = new ActivityFold();
    fold.turn('2026-08-10', 'run-a', true);
    fold.turn('2026-08-11', 'run-a', true);
    fold.turn('2026-08-11', 'run-b', false);

    expect(fold.period(null).activeThreads).toBe(2);
    expect(fold.day('2026-08-11', null).activeThreads).toBe(2);
    expect(fold.day('2026-08-10', null).activeThreads).toBe(1);
  });

  it('averages working time over the threads that reported it, not over every active thread', () => {
    const fold = new ActivityFold();
    fold.turn('2026-08-10', 'run-a', true);
    fold.turn('2026-08-10', 'run-b', false);

    // Two threads were active, but only run-a reported working time: the average is over one.
    expect(fold.period(90_000)).toMatchObject({
      activeThreads: 2,
      threadsWithWorkedTime: 1,
      avgWorkedMs: 90_000,
    });
  });

  it('reads no average when no thread reported working time', () => {
    const fold = new ActivityFold();
    fold.turn('2026-08-10', 'run-a', false);

    expect(fold.period(null).avgWorkedMs).toBeNull();
    expect(fold.period(0).avgWorkedMs).toBeNull();
  });

  it('keeps a day nothing was measured on null, and a measured day with no growth at zero', () => {
    const fold = new ActivityFold();
    fold.lines('2026-08-11', 0, 0, false);

    expect(fold.day('2026-08-11', null)).toMatchObject({
      linesAdded: 0,
      linesRemoved: 0,
    });
    expect(fold.day('2026-08-12', null)).toMatchObject({
      linesAdded: null,
      linesRemoved: null,
    });
    expect(fold.period(null)).toMatchObject({ linesAdded: 0, linesRemoved: 0 });
  });

  it('flags a day, and the period, as partial when any measurement fed it was a lower bound', () => {
    const fold = new ActivityFold();
    fold.lines('2026-08-10', 5, 0, true);
    fold.lines('2026-08-11', 3, 1, false);

    expect(fold.day('2026-08-10', null).linesPartial).toBe(true);
    expect(fold.day('2026-08-11', null).linesPartial).toBe(false);
    expect(fold.period(null)).toMatchObject({
      linesAdded: 8,
      linesRemoved: 1,
      linesPartial: true,
    });
  });

  it('files threads and pull requests under the day they happened', () => {
    const fold = new ActivityFold();
    fold.thread('2026-08-10');
    fold.thread('2026-08-10');
    fold.thread('2026-08-11');
    fold.pullRequest('2026-08-11');

    expect(fold.day('2026-08-10', null)).toMatchObject({
      threadsCreated: 2,
      pullRequests: 0,
    });
    expect(fold.day('2026-08-11', null)).toMatchObject({
      threadsCreated: 1,
      pullRequests: 1,
    });
    expect(fold.period(null)).toMatchObject({
      threadsCreated: 3,
      pullRequests: 1,
    });
  });
});

describe('linesIncrements', () => {
  it("measures a thread's first snapshot in the period past the highest total it reached before it", () => {
    const peaks = new Map([['run:run-a', { linesAdded: 10, linesRemoved: 1 }]]);

    expect(
      linesIncrements(
        [snapshot('run-a', '2026-08-10T12:00:00Z', 25, 4)],
        peaks,
      ),
    ).toEqual([
      {
        key: 'run:run-a',
        occurredAt: at('2026-08-10T12:00:00Z'),
        addedDelta: 15,
        removedDelta: 3,
        partial: false,
      },
    ]);
  });

  it('counts a thread whole when it has no earlier snapshot', () => {
    expect(
      linesIncrements(
        [snapshot('run-b', '2026-08-10T12:00:00Z', 40, 3)],
        new Map(),
      ),
    ).toEqual([
      {
        key: 'run:run-b',
        occurredAt: at('2026-08-10T12:00:00Z'),
        addedDelta: 40,
        removedDelta: 3,
        partial: false,
      },
    ]);
  });

  it('adds nothing for a fall back, and a rise counts only past the highest total', () => {
    const increments = linesIncrements(
      [
        snapshot('run-c', '2026-08-10T09:00:00Z', 30, 0),
        snapshot('run-c', '2026-08-11T09:00:00Z', 20, 0),
        snapshot('run-c', '2026-08-11T15:00:00Z', 36, 0),
      ],
      new Map(),
    );

    expect(increments.map((increment) => increment.addedDelta)).toEqual([
      30, 0, 6,
    ]);
  });

  it('does not count the same lines twice when a total falls back to an earlier figure and returns', () => {
    // A checkout moved to a branch that forked earlier, and back: the lines that come back
    // were counted on the way up.
    const increments = linesIncrements(
      [
        snapshot('run-h', '2026-08-10T09:00:00Z', 500, 0),
        snapshot('run-h', '2026-08-10T12:00:00Z', 40, 0),
        snapshot('run-h', '2026-08-10T15:00:00Z', 500, 0),
      ],
      new Map(),
    );

    expect(increments.map((increment) => increment.addedDelta)).toEqual([
      500, 0, 0,
    ]);
  });

  it('measures growth past the highest total before the period, not past a dip', () => {
    const peaks = new Map([
      ['run:run-i', { linesAdded: 100, linesRemoved: 0 }],
    ]);
    const increments = linesIncrements(
      [
        snapshot('run-i', '2026-08-10T09:00:00Z', 90, 0),
        snapshot('run-i', '2026-08-10T12:00:00Z', 105, 0),
      ],
      peaks,
    );

    expect(increments.map((increment) => increment.addedDelta)).toEqual([0, 5]);
  });

  it('skips a snapshot that was never measured and keeps the one before it as the base', () => {
    const increments = linesIncrements(
      [
        snapshot('run-d', '2026-08-10T09:00:00Z', 10, 0),
        snapshot('run-d', '2026-08-10T12:00:00Z', null, null, null),
        snapshot('run-d', '2026-08-11T09:00:00Z', 14, 0),
      ],
      new Map(),
    );

    expect(increments.map((increment) => increment.addedDelta)).toEqual([
      10, 4,
    ]);
  });

  it("orders each thread's snapshots by time, whatever order they arrive in", () => {
    const increments = linesIncrements(
      [
        snapshot('run-e', '2026-08-11T09:00:00Z', 14, 0),
        snapshot('run-e', '2026-08-10T09:00:00Z', 10, 0),
      ],
      new Map(),
    );

    expect(
      increments.map((increment) => [
        increment.occurredAt.toISOString(),
        increment.addedDelta,
      ]),
    ).toEqual([
      ['2026-08-10T09:00:00.000Z', 10],
      ['2026-08-11T09:00:00.000Z', 4],
    ]);
  });

  it("keeps each thread's baseline apart from every other thread's", () => {
    const peaks = new Map([
      ['run:run-f', { linesAdded: 100, linesRemoved: 0 }],
    ]);
    const increments = linesIncrements(
      [
        snapshot('run-f', '2026-08-10T09:00:00Z', 110, 0),
        snapshot('run-g', '2026-08-10T09:00:00Z', 7, 0),
      ],
      peaks,
    );

    expect(
      increments.map((increment) => [increment.key, increment.addedDelta]),
    ).toEqual([
      ['run:run-f', 10],
      ['run:run-g', 7],
    ]);
  });

  it('folds snapshots that share a line key into one series, whichever thread took them', () => {
    const increments = linesIncrements(
      [
        {
          ...snapshot('run-a', '2026-08-10T09:00:00Z', 40, 2),
          lineKey: 'folder',
        },
        {
          ...snapshot('run-b', '2026-08-10T10:00:00Z', 55, 2),
          lineKey: 'folder',
        },
      ],
      new Map([['folder', { linesAdded: 30, linesRemoved: 2 }]]),
    );

    expect(
      increments.map((increment) => [increment.key, increment.addedDelta]),
    ).toEqual([
      ['folder', 10],
      ['folder', 15],
    ]);
  });
});
