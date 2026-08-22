import { describe, expect, it } from 'vitest';

/** One settled trigger, for the body rules below. */
const settled = (status: 'completed' | 'failed') =>
  ({ runId: 'r1', kind: 'turn-end', status }) as const;

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

  it('says nothing about a turn that did nothing but COMPACT', () => {
    // A `/compact` settles the run like any other turn, so it earned a banner
    // and a sidebar mark for housekeeping the user had just asked for and
    // could see the result of — reported as "no notification needed when
    // compact fires".
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'completed' }),
        new Set(['a']),
      ),
    ).toEqual([]);
  });

  it('still reports the OTHER runs settling in the same reading', () => {
    // The exemption is per run, not per reading: a compaction finishing in one
    // thread must not silence a real answer landing in another at the same
    // moment.
    expect(
      diffRunNotifications(
        reading({ a: 'running', b: 'running' }),
        reading({ a: 'completed', b: 'completed' }),
        new Set(['a']),
      ),
    ).toEqual([{ runId: 'b', kind: 'turn-end', status: 'completed' }]);
  });

  it('still raises a QUESTION from a run marked quiet', () => {
    // The marker describes the last SETTLE. A turn parked on the user is not
    // quiet whatever the previous one was, and it is the state that
    // cannot advance without them.
    expect(
      diffRunNotifications(
        reading({ a: 'running' }),
        reading({ a: 'needs-input' }),
        new Set(['a']),
      ),
    ).toEqual([{ runId: 'a', kind: 'question', status: 'needs-input' }]);
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

  it('says what the agent actually said, not that something happened', () => {
    // The reported complaint: a banner with no content in it. "The turn
    // finished." is true of every turn that ever finished, so it tells the
    // reader nothing the banner's existence had not already told them.
    expect(
      notificationBody(
        settled('completed'),
        null,
        'Fixed the parser — 3 tests green.',
      ),
    ).toBe('Fixed the parser — 3 tests green.');
  });

  it('leads a failure with the failure’s own message', () => {
    expect(
      notificationBody(settled('failed'), null, 'claude exited with code 1'),
    ).toBe('Failed: claude exited with code 1');
  });

  it('opens on the first line that reads as prose, not on a heading or a fence', () => {
    // An agent's answer routinely opens with a heading or a code fence, and a
    // banner reading "```ts" is worse than the plain sentence.
    expect(
      notificationBody(
        settled('completed'),
        null,
        '## Result\n\n```ts\nconst x = 1;\n```\nAll three checks pass.',
      ),
    ).toBe('Result');
    expect(
      notificationBody(settled('completed'), null, '```\ncode only\n```'),
    ).toBe('code only');
  });

  it('truncates a long answer on a word, and marks that it was cut', () => {
    const long = `${'word '.repeat(80)}end`;
    const body = notificationBody(settled('completed'), null, long);

    expect(body.length).toBeLessThanOrEqual(221);
    expect(body.endsWith('…')).toBe(true);
    expect(body).not.toContain('wor…');
  });

  it('falls back to the plain sentence when the text carries nothing readable', () => {
    // Whitespace, and an absent summary, are the same thing to a reader.
    expect(notificationBody(settled('completed'), null, '   \n\n')).toBe(
      'The turn finished.',
    );
    expect(notificationBody(settled('failed'), null, null)).toBe(
      'The turn failed.',
    );
  });

  it('never lets a settle summary hijack a QUESTION banner', () => {
    // A parked run is not reporting an outcome — it is asking. The phrase is
    // what the sidebar row says under the same badge, and the two must agree.
    expect(
      notificationBody(
        { runId: 'a', kind: 'question', status: 'needs-input' },
        null,
        'some earlier answer',
      ),
    ).toBe('Waiting for you.');
  });
});
