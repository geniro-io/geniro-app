import { describe, expect, it } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { boardColumnOf } from './board-column';

type BoardRun = Pick<
  RunWire,
  | 'status'
  | 'awaiting'
  | 'outcome'
  | 'pullRequests'
  | 'holdingFor'
  | 'shellsOpen'
  | 'subagentsOut'
  | 'monitorsOpen'
>;

const OPENED_PR = {
  owner: 'geniro-io',
  repo: 'geniro-app',
  number: 7,
  url: 'https://github.com/geniro-io/geniro-app/pull/7',
  seq: 3,
  opened: true,
} as unknown as RunWire['pullRequests'][number];

function run(over: Partial<BoardRun> = {}): BoardRun {
  return {
    status: 'completed',
    awaiting: null,
    outcome: null,
    pullRequests: [],
    ...over,
  } as BoardRun;
}

const OUTCOME = {
  kind: 'success',
  summary: null,
  source: 'recorded',
} as unknown as RunWire['outcome'];

describe('boardColumnOf', () => {
  it('places a thread waiting on the user first, ahead of working, done and review', () => {
    expect(
      boardColumnOf(run({ status: 'running', awaiting: 'approval' }), 'done'),
    ).toBe('waiting');
    expect(
      boardColumnOf(
        run({ status: 'completed', awaiting: 'question', outcome: OUTCOME }),
        'in_review',
      ),
    ).toBe('waiting');
  });

  it('places a running thread in working, even when its card is Done or it has an outcome', () => {
    expect(boardColumnOf(run({ status: 'running' }), 'done')).toBe('working');
    expect(
      boardColumnOf(run({ status: 'running', outcome: OUTCOME }), null),
    ).toBe('working');
  });

  it('places a thread whose card is Done, or that recorded an outcome, in done', () => {
    expect(boardColumnOf(run(), 'done')).toBe('done');
    expect(boardColumnOf(run({ outcome: OUTCOME }), null)).toBe('done');
  });

  it('prefers done over in review when both hold', () => {
    expect(
      boardColumnOf(
        run({ outcome: OUTCOME, pullRequests: [OPENED_PR] }),
        'in_review',
      ),
    ).toBe('done');
  });

  it('places a thread whose card is In review, or that opened a pull request, in review', () => {
    expect(boardColumnOf(run(), 'in_review')).toBe('in_review');
    expect(boardColumnOf(run({ pullRequests: [OPENED_PR] }), null)).toBe(
      'in_review',
    );
    expect(boardColumnOf(run({ pullRequests: [OPENED_PR] }), 'todo')).toBe(
      'in_review',
    );
  });

  it('leaves a pull request that was never opened out of review', () => {
    const notOpened = {
      ...OPENED_PR,
      opened: false,
    } as RunWire['pullRequests'][number];

    expect(boardColumnOf(run({ pullRequests: [notOpened] }), null)).toBe(
      'idle',
    );
  });

  it('places a thread with nothing behind it in idle', () => {
    expect(boardColumnOf(run(), null)).toBe('idle');
    expect(boardColumnOf(run({ status: 'failed' }), 'backlog')).toBe('idle');
  });

  it('places a settled thread still holding its turn or a background sub-agent in working, even when it is done', () => {
    expect(boardColumnOf(run({ holdingFor: 1 }), 'done')).toBe('working');
    expect(boardColumnOf(run({ subagentsOut: 2 }), null)).toBe('working');
    expect(
      boardColumnOf(run({ subagentsOut: 1, outcome: OUTCOME }), null),
    ).toBe('working');
  });

  it('places a settled thread with a monitor running in working, even when its goals closed, it recorded an outcome or its card is Done', () => {
    expect(boardColumnOf(run({ monitorsOpen: 1 }), null)).toBe('working');
    expect(
      boardColumnOf(run({ monitorsOpen: 2, outcome: OUTCOME }), null),
    ).toBe('working');
    expect(boardColumnOf(run({ monitorsOpen: 1 }), 'done')).toBe('working');
    expect(
      boardColumnOf(run({ monitorsOpen: 1, pullRequests: [OPENED_PR] }), null),
    ).toBe('working');
  });

  it('places a settled thread with a detached command out in working, unless it is already done', () => {
    expect(boardColumnOf(run({ shellsOpen: 1 }), null)).toBe('working');
    expect(
      boardColumnOf(run({ shellsOpen: 1, pullRequests: [OPENED_PR] }), null),
    ).toBe('working');
    expect(boardColumnOf(run({ shellsOpen: 1, outcome: OUTCOME }), null)).toBe(
      'done',
    );
    expect(boardColumnOf(run({ shellsOpen: 1 }), 'done')).toBe('done');
  });

  it('moves a thread out of working into done or idle once its background work has ended', () => {
    const ended = {
      holdingFor: 0,
      shellsOpen: 0,
      subagentsOut: 0,
      monitorsOpen: 0,
    };

    expect(boardColumnOf(run(ended), 'done')).toBe('done');
    expect(boardColumnOf(run(ended), null)).toBe('idle');
  });

  it('leaves a failed or cancelled thread out of working, whatever it still has out', () => {
    expect(
      boardColumnOf(run({ status: 'failed', holdingFor: 1 }), 'backlog'),
    ).toBe('idle');
    expect(
      boardColumnOf(run({ status: 'cancelled', subagentsOut: 1 }), null),
    ).toBe('idle');
    expect(boardColumnOf(run({ status: 'failed', shellsOpen: 1 }), null)).toBe(
      'idle',
    );
    expect(
      boardColumnOf(run({ status: 'failed', monitorsOpen: 1 }), 'done'),
    ).toBe('done');
  });
});
