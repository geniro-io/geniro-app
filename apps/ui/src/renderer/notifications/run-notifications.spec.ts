import { describe, expect, it } from 'vitest';

import type { RunStatusKind } from '../chats/run-status';
import { diffRunNotifications, notificationBody } from './run-notifications';

const reading = (
  entries: Record<string, RunStatusKind>,
): ReadonlyMap<string, RunStatusKind> => new Map(Object.entries(entries));

describe('diffRunNotifications', () => {
  it('reports a run that parked on a question', () => {
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'needs-input' }),
      ),
    ).toEqual([{ runId: 'a', kind: 'question', status: 'needs-input' }]);
  });

  it('reports a turn that ended', () => {
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'completed' }),
      ),
    ).toEqual([{ runId: 'a', kind: 'turn-end', status: 'completed' }]);
  });

  it('reports a FAILED turn — nobody asked for that one', () => {
    expect(
      diffRunNotifications(reading({ a: 'running' }), reading({ a: 'failed' })),
    ).toEqual([{ runId: 'a', kind: 'turn-end', status: 'failed' }]);
  });

  it('says NOTHING about a run seen for the first time', () => {
    // The chat list loads with every past thread already finished. Reporting
    // those would open the app with a banner per conversation in the history.
    expect(
      diffRunNotifications(
        reading({}),
        reading({ a: 'completed', b: 'failed', c: 'needs-input' }),
      ),
    ).toEqual([]);
  });

  it('says nothing about a turn the USER cancelled', () => {
    // Telling someone what they just did with the Stop button is the
    // notification that gets the whole feature switched off.
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'cancelled' }),
      ),
    ).toEqual([]);
  });

  it('says nothing when a status has not moved', () => {
    expect(
      diffRunNotifications(
        reading({ a: 'needs-input' }),
        reading({ a: 'needs-input' }),
      ),
    ).toEqual([]);
  });

  it('does not re-report a settle a run was ALREADY sitting in', () => {
    // `completed` → `failed` on a run that never went back to work is a row
    // being corrected, not a turn ending.
    expect(
      diffRunNotifications(
        reading({ a: 'completed' }),
        reading({ a: 'failed' }),
      ),
    ).toEqual([]);
  });

  it('reports the SECOND question in a thread, not just the first', () => {
    // Each reading is diffed against the last, so a thread that asks, is
    // answered, works and asks again earns a banner both times.
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'needs-input' }),
      ),
    ).toHaveLength(1);
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'needs-input' }),
      ),
    ).toHaveLength(1);
  });

  it('calls a parked turn a question, never a settle', () => {
    // `needs-input` is not a settled status, so only the question arm can
    // match — pinned because reordering the branches is how a parked turn
    // would come to be announced as finished.
    expect(
      diffRunNotifications(
        reading({ a: 'pending' }),
        reading({ a: 'needs-input' }),
      ),
    ).toEqual([{ runId: 'a', kind: 'question', status: 'needs-input' }]);
  });

  it('follows every run at once, not only the one on screen', () => {
    expect(
      diffRunNotifications(
        reading({ a: 'running', b: 'running', c: 'running' }),
        reading({ a: 'needs-input', b: 'completed', c: 'running' }),
      ),
    ).toEqual([
      { runId: 'a', kind: 'question', status: 'needs-input' },
      { runId: 'b', kind: 'turn-end', status: 'completed' },
    ]);
  });

  it('says nothing about a run that disappeared', () => {
    expect(
      diffRunNotifications(reading({ a: 'running' }), reading({})),
    ).toEqual([]);
  });
});

describe('notificationBody', () => {
  it('names which kind of answer a parked run wants', () => {
    expect(
      notificationBody(
        { runId: 'a', kind: 'question', status: 'needs-input' },
        'question',
      ),
    ).toBe('Waiting for your answer.');
    expect(
      notificationBody(
        { runId: 'a', kind: 'question', status: 'needs-input' },
        'approval',
      ),
    ).toBe('Waiting for approval.');
  });

  it('falls back to a truthful vaguer line when the row says nothing', () => {
    expect(
      notificationBody(
        { runId: 'a', kind: 'question', status: 'needs-input' },
        null,
      ),
    ).toBe('Waiting for you.');
  });

  it('does not announce a failure as a completion', () => {
    expect(
      notificationBody(
        { runId: 'a', kind: 'turn-end', status: 'failed' },
        null,
      ),
    ).toBe('The turn failed.');
    expect(
      notificationBody(
        { runId: 'a', kind: 'turn-end', status: 'completed' },
        null,
      ),
    ).toBe('The turn finished.');
  });
});
