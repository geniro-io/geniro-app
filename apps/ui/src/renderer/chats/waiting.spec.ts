import { describe, expect, it } from 'vitest';

import type { RunStatusKind } from './run-status';
import {
  nextWaiting,
  rankByUrgency,
  waitCounts,
  type WaitReading,
  waitReadings,
  waitStateOf,
} from './waiting';

interface Row {
  id: string;
  status: RunStatusKind;
  attentionAt: string | null;
  lastActivityAt: string | null;
  updatedAt: string;
}

function row(
  id: string,
  status: RunStatusKind,
  attentionAt: string | null,
  updatedAt = '2026-01-01T00:00:00.000Z',
): Row {
  return { id, status, attentionAt, lastActivityAt: null, updatedAt };
}

function readings(rows: Row[], unseen: string[] = []): WaitReading[] {
  return waitReadings(rows, {
    statusOf: (run) => run.status,
    unseen: new Set(unseen),
  });
}

describe('waitStateOf', () => {
  it('reads an open card as asking, whatever the unread mark says', () => {
    expect(waitStateOf({ status: 'needs-input', unseen: false })).toBe(
      'asking',
    );
    expect(waitStateOf({ status: 'needs-input', unseen: true })).toBe('asking');
  });

  it('reads a failure as news only while it is unseen', () => {
    expect(waitStateOf({ status: 'failed', unseen: true })).toBe('failed');
    expect(waitStateOf({ status: 'failed', unseen: false })).toBeNull();
  });

  it('reads an unseen ending as an unseen reply, and a seen one as nothing', () => {
    expect(waitStateOf({ status: 'completed', unseen: true })).toBe('unseen');
    expect(waitStateOf({ status: 'completed', unseen: false })).toBeNull();
  });

  it('reads a thread that is working again as working, over an older unread reply', () => {
    expect(waitStateOf({ status: 'running', unseen: true })).toBe('working');
    expect(waitStateOf({ status: 'held', unseen: true })).toBe('working');
  });

  it('reads running and held as working, and pending as nothing', () => {
    expect(waitStateOf({ status: 'running', unseen: false })).toBe('working');
    expect(waitStateOf({ status: 'held', unseen: false })).toBe('working');
    expect(waitStateOf({ status: 'pending', unseen: false })).toBeNull();
  });
});

describe('waitReadings', () => {
  it('ranks asking > failed > unseen > working, oldest wait first within one', () => {
    const ranked = readings(
      [
        row('working', 'running', null, '2026-01-01T00:00:01.000Z'),
        row('unseen-new', 'completed', '2026-01-01T00:05:00.000Z'),
        row('unseen-old', 'completed', '2026-01-01T00:01:00.000Z'),
        row('failed', 'failed', '2026-01-01T00:09:00.000Z'),
        row('asking-new', 'needs-input', '2026-01-01T00:08:00.000Z'),
        row('asking-old', 'needs-input', '2026-01-01T00:02:00.000Z'),
        row('idle', 'completed', '2026-01-01T00:00:00.000Z'),
      ],
      ['unseen-new', 'unseen-old', 'failed'],
    );
    expect(ranked.map((reading) => reading.runId)).toEqual([
      'asking-old',
      'asking-new',
      'failed',
      'unseen-old',
      'unseen-new',
      'working',
    ]);
  });

  it.each([
    [
      'attentionAt',
      '2026-03-01T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
    ],
    [
      'the last activity',
      null,
      '2026-03-02T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ],
    ['the row update', null, null, '2026-03-03T00:00:00.000Z'],
  ] as const)(
    'dates a wait by %s when that is the first moment the row has',
    (_, attentionAt, lastActivityAt, expected) => {
      const [reading] = readings([
        {
          ...row('a', 'running', attentionAt, '2026-03-03T00:00:00.000Z'),
          lastActivityAt,
        },
      ]);
      expect(reading?.since).toBe(expected);
    },
  );
});

describe('rankByUrgency', () => {
  it('keeps the incoming order inside a state when nothing dates the items', () => {
    const nodes = [
      { id: 'done', status: 'completed' as const },
      { id: 'run-1', status: 'running' as const },
      { id: 'ask', status: 'needs-input' as const },
      { id: 'run-2', status: 'running' as const },
    ];
    expect(
      rankByUrgency(nodes, (node) =>
        waitStateOf({ status: node.status, unseen: false }),
      ).map((node) => node.id),
    ).toEqual(['ask', 'run-1', 'run-2', 'done']);
  });
});

describe('nextWaiting', () => {
  const ranked = readings(
    [
      row('approval', 'needs-input', '2026-01-01T00:01:00.000Z'),
      row('reply', 'completed', '2026-01-01T00:02:00.000Z'),
      row('busy', 'running', null),
    ],
    ['reply'],
  );
  const at = (runId: string): WaitReading =>
    ranked.find((reading) => reading.runId === runId)!;

  it('opens the longest wait first when nothing was jumped to', () => {
    expect(nextWaiting(ranked, null)?.runId).toBe('approval');
  });

  it('moves to the next wait on each press and wraps round', () => {
    expect(nextWaiting(ranked, at('approval'))?.runId).toBe('reply');
    expect(nextWaiting(ranked, at('reply'))?.runId).toBe('approval');
  });

  it('goes on past a reply that opening it took out of the queue', () => {
    // Asking A, then unread B and C. Opening B sees it, so B is gone from the
    // next reading: the cycle must continue to C, not start again at A.
    const before = readings(
      [
        row('a', 'needs-input', '2026-01-01T00:01:00.000Z'),
        row('b', 'completed', '2026-01-01T00:02:00.000Z'),
        row('c', 'completed', '2026-01-01T00:03:00.000Z'),
      ],
      ['b', 'c'],
    );
    const opened = before.find((reading) => reading.runId === 'b')!;
    const after = readings(
      [
        row('a', 'needs-input', '2026-01-01T00:01:00.000Z'),
        row('b', 'completed', '2026-01-01T00:02:00.000Z'),
        row('c', 'completed', '2026-01-01T00:03:00.000Z'),
      ],
      ['c'],
    );
    expect(nextWaiting(after, opened)?.runId).toBe('c');
  });

  it('goes on to a reply whose wait began at the same moment as the last one', () => {
    const same = '2026-01-01T00:02:00.000Z';
    const before = readings(
      [
        row('a', 'needs-input', '2026-01-01T00:01:00.000Z'),
        row('b', 'completed', same),
        row('c', 'completed', same),
      ],
      ['b', 'c'],
    );
    const opened = before.find((reading) => reading.runId === 'b')!;
    const after = before.filter((reading) => reading.runId !== 'b');
    expect(before.map((reading) => reading.runId)).toEqual(['a', 'b', 'c']);
    expect(nextWaiting(after, opened)?.runId).toBe('c');
  });

  it('wraps to the head when nothing is ranked after the last jump', () => {
    const gone: WaitReading = {
      runId: 'seen',
      state: 'unseen',
      since: '2026-01-01T09:00:00.000Z',
    };
    expect(nextWaiting(ranked, gone)?.runId).toBe('approval');
  });

  it('never lands on a thread that is only working', () => {
    const working = readings([row('busy', 'running', null)]);
    expect(nextWaiting(working, null)).toBeNull();
  });
});

describe('waitCounts', () => {
  it('counts each wait on the user and leaves working out', () => {
    expect(
      waitCounts(
        readings(
          [
            row('a', 'needs-input', '2026-01-01T00:00:00.000Z'),
            row('b', 'failed', '2026-01-01T00:00:00.000Z'),
            row('c', 'completed', '2026-01-01T00:00:00.000Z'),
            row('d', 'completed', '2026-01-01T00:00:00.000Z'),
            row('e', 'running', null),
          ],
          ['b', 'c', 'd'],
        ),
      ),
    ).toEqual({ asking: 1, failed: 1, unseen: 2 });
  });
});
