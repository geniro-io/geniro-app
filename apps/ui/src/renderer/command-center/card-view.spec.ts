import { describe, expect, it } from 'vitest';

import {
  attentionOf,
  IDLE_AFTER_DAYS,
  idleDaysOf,
  orderByAttention,
  statusTextOf,
  threadCardViewOf,
} from './card-view';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 24 * 60 * 60_000;

describe('idleDaysOf', () => {
  it('says nothing for a thread that moved within the last few days', () => {
    expect(
      idleDaysOf(
        new Date(NOW - (IDLE_AFTER_DAYS - 0.5) * DAY).toISOString(),
        NOW,
      ),
    ).toBeNull();
  });

  it('counts the whole days once a thread has sat still long enough', () => {
    expect(
      idleDaysOf(new Date(NOW - IDLE_AFTER_DAYS * DAY).toISOString(), NOW),
    ).toBe(IDLE_AFTER_DAYS);
    expect(idleDaysOf(new Date(NOW - 14.7 * DAY).toISOString(), NOW)).toBe(14);
  });
});

const HOUR = 60 * 60_000;

function cardOf(
  over: {
    status?: string;
    awaiting?: 'question' | 'approval' | null;
    column?: 'working' | 'waiting' | 'idle' | 'in_review' | 'done';
    awaitingReply?: boolean;
    lastAt?: number;
  } = {},
): Parameters<typeof attentionOf>[0] {
  return {
    run: {
      status: over.status ?? 'completed',
      awaiting: over.awaiting ?? null,
      lastActivityAt: new Date(over.lastAt ?? NOW - HOUR).toISOString(),
      createdAt: new Date(NOW - 30 * DAY).toISOString(),
    },
    column: over.column ?? 'idle',
    contact: { lastAt: null, awaitingReply: over.awaitingReply ?? false },
  } as Parameters<typeof attentionOf>[0];
}

describe('attentionOf', () => {
  it('puts a failed thread or one held at an approval among the blocked', () => {
    expect(attentionOf(cardOf({ status: 'failed' }), NOW)).toBe('blocked');
    expect(
      attentionOf(
        cardOf({ awaiting: 'approval', column: 'waiting', status: 'running' }),
        NOW,
      ),
    ).toBe('blocked');
  });

  it('puts a running thread among the working', () => {
    expect(
      attentionOf(cardOf({ column: 'working', status: 'running' }), NOW),
    ).toBe('working');
  });

  it('puts only a thread asking the user among the questions, even when the manager also awaits it', () => {
    expect(
      attentionOf(
        cardOf({ awaiting: 'question', column: 'waiting', status: 'running' }),
        NOW,
      ),
    ).toBe('question');
    expect(
      attentionOf(
        cardOf({
          awaiting: 'question',
          column: 'waiting',
          awaitingReply: true,
        }),
        NOW,
      ),
    ).toBe('question');
  });

  it('puts a still thread the manager awaits a reply from among the working', () => {
    expect(
      attentionOf(
        cardOf({ awaitingReply: true, lastAt: NOW - 25 * HOUR }),
        NOW,
      ),
    ).toBe('working');
  });

  it('calls a still thread quiet within a day and inactive after', () => {
    expect(attentionOf(cardOf({ lastAt: NOW - 23 * HOUR }), NOW)).toBe('quiet');
    expect(attentionOf(cardOf({ lastAt: NOW - 25 * HOUR }), NOW)).toBe(
      'inactive',
    );
  });
});

describe('orderByAttention', () => {
  const entry = (
    id: string,
    attention: string,
    hoursAgo: number,
    startedHoursAgo = 100,
  ) => ({
    id,
    createdAt: new Date(NOW - startedHoursAgo * HOUR).toISOString(),
    view: {
      attention: attention as ReturnType<typeof attentionOf>,
      lastAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    },
  });

  it('stands working threads newest started first, whichever spoke last', () => {
    expect(
      orderByAttention([
        entry('old-start-just-spoke', 'working', 0, 9),
        entry('new-start-quiet-a-while', 'working', 2, 1),
        entry('middle-start', 'working', 1, 5),
      ]).map((item) => item.id),
    ).toEqual([
      'new-start-quiet-a-while',
      'middle-start',
      'old-start-just-spoke',
    ]);
  });

  it('keeps working threads started at the same moment in one fixed order, whichever spoke last', () => {
    const order = (zSpokeHoursAgo: number) =>
      orderByAttention([
        entry('z-thread', 'working', zSpokeHoursAgo, 4),
        entry('a-thread', 'working', 1, 4),
      ]).map((item) => item.id);

    expect(order(0)).toEqual(['a-thread', 'z-thread']);
    expect(order(2)).toEqual(['a-thread', 'z-thread']);
  });

  it('keeps newest activity first in the bands that do not stream, whenever each thread started', () => {
    expect(
      orderByAttention([
        entry('quiet-old-activity-new-start', 'quiet', 5, 6),
        entry('quiet-new-activity-old-start', 'quiet', 1, 90),
        entry('blocked-old', 'blocked', 9, 10),
        entry('blocked-new', 'blocked', 2, 80),
      ]).map((item) => item.id),
    ).toEqual([
      'blocked-new',
      'blocked-old',
      'quiet-new-activity-old-start',
      'quiet-old-activity-new-start',
    ]);
  });

  it('orders by attention band, newest activity first within a band', () => {
    expect(
      orderByAttention([
        entry('old-quiet', 'quiet', 5),
        entry('inactive', 'inactive', 50),
        entry('new-quiet', 'quiet', 1),
        entry('working', 'working', 3),
        entry('blocked', 'blocked', 9),
        entry('question', 'question', 2),
      ]).map((item) => item.id),
    ).toEqual([
      'blocked',
      'question',
      'working',
      'new-quiet',
      'old-quiet',
      'inactive',
    ]);
  });
});

describe('statusTextOf', () => {
  it('says why a blocked or questioned thread stands in its band', () => {
    const card = (over: Parameters<typeof cardOf>[0]) => cardOf(over);

    expect(statusTextOf(card({ status: 'failed' }), 'failed', 'blocked')).toBe(
      'Failed',
    );
    expect(
      statusTextOf(card({ awaiting: 'approval' }), 'waiting', 'blocked'),
    ).toBe('Needs approval');
    expect(
      statusTextOf(card({ awaiting: 'question' }), 'waiting', 'question'),
    ).toBe('Question for you');
    expect(statusTextOf(card({ awaitingReply: true }), 'idle', 'working')).toBe(
      'Awaiting reply',
    );
    expect(
      statusTextOf(
        card({ awaitingReply: true, column: 'working' }),
        'working',
        'working',
      ),
    ).toBe('Working');
    expect(statusTextOf(card({}), 'idle', 'quiet')).toBe('Idle');
  });
});

describe('threadCardViewOf — project colour', () => {
  const boardCard = (project: { id: string; name: string } | null) =>
    ({
      run: {
        id: 'run-1',
        title: 'Fix the login redirect',
        status: 'completed',
        awaiting: null,
        lastActivityAt: new Date(NOW - HOUR).toISOString(),
        createdAt: new Date(NOW - DAY).toISOString(),
        project,
        teamId: null,
        agentKind: null,
        pullRequests: [],
      },
      column: 'idle',
      contact: { lastAt: null, awaitingReply: false },
      task: null,
      note: null,
      activity: null,
    }) as unknown as Parameters<typeof threadCardViewOf>[0];

  it('carries the colour the graph gave the thread’s project', () => {
    const view = threadCardViewOf(
      boardCard({ id: 'p-web', name: 'Web' }),
      null,
      [],
      new Map(),
      NOW,
      new Map([['p-web', 'orange']]),
    );

    expect(view.project).toBe('Web');
    expect(view.projectColor).toBe('orange');
  });

  it('carries no colour for a thread with no project, or one the graph has not coloured', () => {
    const colors = new Map([['p-web', 'orange' as const]]);
    expect(
      threadCardViewOf(boardCard(null), null, [], new Map(), NOW, colors)
        .projectColor,
    ).toBeNull();
    expect(
      threadCardViewOf(
        boardCard({ id: 'p-api', name: 'Api' }),
        null,
        [],
        new Map(),
        NOW,
        colors,
      ).projectColor,
    ).toBeNull();
  });
});
