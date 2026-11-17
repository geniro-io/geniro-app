import { describe, expect, it } from 'vitest';

import { STRIP_MAX_MARKERS, type ThreadStrip } from '../command-center.types';
import {
  foldThreadStrip,
  type StripInput,
  type StripRow,
} from './thread-strip-fold';

const START = Date.parse('2026-11-17T08:00:00.000Z');
const NOW = START + 8 * 60 * 60_000;

const at = (minutes: number): number => START + minutes * 60_000;
const iso = (minutes: number): string => new Date(at(minutes)).toISOString();

function row(
  kind: string,
  minutes: number,
  payload: unknown = {},
  extra: Partial<StripRow> = {},
): StripRow {
  return {
    kind,
    role: null,
    memberId: null,
    createdAt: new Date(at(minutes)),
    payload: JSON.stringify(payload),
    ...extra,
  };
}

function userMessage(minutes: number, text: string): StripRow {
  return row('message', minutes, { text }, { role: 'user' });
}

function fold(input: Partial<StripInput> = {}): ThreadStrip {
  return foldThreadStrip({
    rows: [],
    start: START,
    now: NOW,
    running: false,
    awaiting: false,
    pullRequests: [],
    mail: [],
    ...input,
  });
}

describe('foldThreadStrip: work spans', () => {
  it('closes a work span from a turn’s running row to its turn_complete', () => {
    const { spans } = fold({
      rows: [
        row('status', 10, { status: 'running' }),
        row('turn_complete', 25),
      ],
    });

    expect(spans).toEqual([{ kind: 'work', start: iso(10), end: iso(25) }]);
  });

  it('opens a work span at the turn’s start while the turn has not completed', () => {
    const { spans } = fold({
      rows: [row('status', 10, { status: 'running' })],
      running: true,
    });

    expect(spans).toEqual([{ kind: 'work', start: iso(10), end: null }]);
  });

  it('ends a running turn’s work where an open card starts its wait, as the chat’s clock does', () => {
    const { spans } = fold({
      rows: [
        row('status', 10, { status: 'running' }),
        row('approval_request', 30, { id: 'a1', toolName: 'Bash' }),
      ],
      running: true,
      awaiting: true,
    });

    expect(spans).toEqual([
      { kind: 'work', start: iso(10), end: iso(30) },
      { kind: 'waiting', start: iso(30), end: null },
    ]);
  });

  it('draws no work for a running turn that has waited on the user since the window opened', () => {
    expect(fold({ running: true, awaiting: true }).spans).toEqual([
      { kind: 'waiting', start: iso(0), end: null },
    ]);
  });

  it('opens a work span at the window’s start when the run is running and no running row was read', () => {
    expect(fold({ running: true }).spans).toEqual([
      { kind: 'work', start: iso(0), end: null },
    ]);
  });

  it('clips a turn that began before the window to the window’s left edge', () => {
    const { spans } = fold({
      rows: [
        row('status', -60, { status: 'running' }),
        row('turn_complete', 30),
      ],
    });

    expect(spans).toEqual([{ kind: 'work', start: iso(0), end: iso(30) }]);
  });

  it('drops a turn that ended before the window', () => {
    const { spans } = fold({
      rows: [
        row('status', -120, { status: 'running' }),
        row('turn_complete', -60),
      ],
    });

    expect(spans).toEqual([]);
  });

  it('keeps a span that runs past now open, cut at now', () => {
    const { spans } = fold({
      rows: [
        row('status', 470, { status: 'running' }),
        row('turn_complete', 500),
      ],
    });

    expect(spans).toEqual([{ kind: 'work', start: iso(470), end: null }]);
  });
});

describe('foldThreadStrip: waiting spans', () => {
  it('closes a waiting span from a card’s approval_request to its verdict', () => {
    const { spans } = fold({
      rows: [
        row('approval_request', 10, { id: 'a1', toolName: 'Bash' }),
        row('approval_verdict', 40, { id: 'a1' }),
      ],
    });

    expect(spans).toEqual([{ kind: 'waiting', start: iso(10), end: iso(40) }]);
  });

  it('keeps a waiting span open while its card is still open', () => {
    const { spans } = fold({
      rows: [row('approval_request', 10, { id: 'a1', toolName: 'Bash' })],
    });

    expect(spans).toEqual([{ kind: 'waiting', start: iso(10), end: null }]);
  });

  it('opens a waiting span at the window’s start when the run awaits a reply it has no card for', () => {
    expect(fold({ awaiting: true }).spans).toEqual([
      { kind: 'waiting', start: iso(0), end: null },
    ]);
  });
});

describe('foldThreadStrip: markers', () => {
  it('labels a user message with its text on one line', () => {
    const { markers } = fold({
      rows: [userMessage(5, 'Build is\nred again')],
    });

    expect(markers).toEqual([
      { kind: 'user_message', at: iso(5), label: 'Build is red again' },
    ]);
  });

  it('leaves a member’s own message out of the markers', () => {
    const { markers } = fold({
      rows: [
        row(
          'message',
          6,
          { text: 'agent text' },
          { role: 'user', memberId: 'm1' },
        ),
      ],
    });

    expect(markers).toEqual([]);
  });

  it('marks a question with the first question of its approval_request', () => {
    const { markers } = fold({
      rows: [
        row('approval_request', 10, {
          id: 'q1',
          questions: [{ question: 'Which database?' }],
        }),
      ],
    });

    expect(markers).toEqual([
      { kind: 'question', at: iso(10), label: 'Which database?' },
    ]);
  });

  it('does not mark a plain permission request as a question', () => {
    const { markers, spans } = fold({
      rows: [row('approval_request', 12, { id: 'p1', toolName: 'Bash' })],
    });

    expect(markers).toEqual([]);
    expect(spans).toEqual([{ kind: 'waiting', start: iso(12), end: null }]);
  });

  it('labels a failure with its error message', () => {
    const { markers } = fold({
      rows: [row('error', 15, { message: 'Rate limit\nreached' })],
    });

    expect(markers).toEqual([
      { kind: 'failure', at: iso(15), label: 'Rate limit reached' },
    ]);
  });

  it('labels a stage change with its stage title', () => {
    const { markers } = fold({
      rows: [row('stage_change', 20, { stageTitle: 'Review' })],
    });

    expect(markers).toEqual([{ kind: 'stage', at: iso(20), label: 'Review' }]);
  });

  it('marks an opened pull request with its number, and each manager message by its direction', () => {
    const { markers } = fold({
      pullRequests: [{ at: at(30), label: '#42' }],
      mail: [
        { at: at(31), direction: 'out' },
        { at: at(32), direction: 'in' },
      ],
    });

    expect(markers).toEqual([
      { kind: 'pr_opened', at: iso(30), label: '#42' },
      { kind: 'manager_out', at: iso(31), label: null },
      { kind: 'manager_in', at: iso(32), label: null },
    ]);
  });

  it('keeps markers from the window’s two edges and drops those beyond them', () => {
    const { markers } = fold({
      rows: [
        userMessage(-1, 'before'),
        userMessage(0, 'left edge'),
        userMessage(480, 'right edge'),
        userMessage(481, 'after'),
      ],
    });

    expect(markers.map((marker) => marker.label)).toEqual([
      'left edge',
      'right edge',
    ]);
  });

  it('keeps the newest STRIP_MAX_MARKERS markers, in time order', () => {
    const total = STRIP_MAX_MARKERS + 5;
    const rows = Array.from({ length: total }, (_, index) =>
      row('error', index + 1, { message: `failure ${index + 1}` }),
    );

    const { markers } = fold({ rows });

    expect(markers).toHaveLength(STRIP_MAX_MARKERS);
    expect(markers[0]).toEqual({
      kind: 'failure',
      at: iso(6),
      label: 'failure 6',
    });
    expect(markers.at(-1)).toEqual({
      kind: 'failure',
      at: iso(total),
      label: `failure ${total}`,
    });
  });
});
