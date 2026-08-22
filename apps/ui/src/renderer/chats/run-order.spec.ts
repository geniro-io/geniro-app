import { describe, expect, it } from 'vitest';

import { sortRunsForSidebar } from './run-order';
import type { RunStatusKind } from './run-status';

interface Row {
  id: string;
  status: RunStatusKind;
  updatedAt: string;
  createdAt: string;
}

function run(
  id: string,
  status: RunStatusKind,
  updatedAt: string,
  createdAt = '2026-01-01T00:00:00.000Z',
): Row {
  return { id, status, updatedAt, createdAt };
}

const statusOf = (row: Row): RunStatusKind => row.status;

function order(rows: Row[]): string[] {
  return sortRunsForSidebar(rows, { statusOf }).map((row) => row.id);
}

describe('sortRunsForSidebar', () => {
  it('puts a thread waiting on an answer above everything, however old', () => {
    // The oldest activity in the list, and still first: the tier outranks
    // recency, which is the whole point of having tiers.
    const rows = [
      run('fresh', 'completed', '2026-03-01T00:00:00.000Z'),
      run('asking', 'needs-input', '2020-01-01T00:00:00.000Z'),
      run('running', 'running', '2026-02-01T00:00:00.000Z'),
    ];
    expect(order(rows)).toEqual(['asking', 'fresh', 'running']);
  });

  it('orders by last activity inside a tier — a thread just written in leads', () => {
    // `updatedAt` is the daemon's own write to the run row, and writing a
    // message flips that row to `running`, so this is what brings a thread up.
    const rows = [
      run('stale', 'completed', '2026-01-01T00:00:00.000Z'),
      run('just-wrote', 'running', '2026-05-01T00:00:00.000Z'),
      run('yesterday', 'completed', '2026-04-30T00:00:00.000Z'),
    ];
    expect(order(rows)).toEqual(['just-wrote', 'yesterday', 'stale']);
  });

  it('does NOT float a running thread — it rises on activity like any other', () => {
    // Running is not "needs attention": nothing is being asked of the user. A
    // tier for it would pin every background job above the conversation the
    // user is actually reading.
    const rows = [
      run('running-old', 'running', '2026-01-01T00:00:00.000Z'),
      run('done-new', 'completed', '2026-05-01T00:00:00.000Z'),
    ];
    expect(order(rows)).toEqual(['done-new', 'running-old']);
  });

  it('breaks an activity tie by creation time, never by arrival order', () => {
    const same = '2026-05-01T00:00:00.000Z';
    const rows = [
      run('older', 'completed', same, '2026-01-01T00:00:00.000Z'),
      run('newer', 'completed', same, '2026-02-01T00:00:00.000Z'),
    ];
    expect(order(rows)).toEqual(['newer', 'older']);
    // Reversing the input must not reverse the answer, or the sidebar's order
    // depends on which fetch happened to resolve first.
    expect(order([...rows].reverse())).toEqual(['newer', 'older']);
  });

  it('does not mutate the array it was given', () => {
    const rows = [
      run('a', 'completed', '2026-01-01T00:00:00.000Z'),
      run('b', 'needs-input', '2026-02-01T00:00:00.000Z'),
    ];
    sortRunsForSidebar(rows, { statusOf });
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});
