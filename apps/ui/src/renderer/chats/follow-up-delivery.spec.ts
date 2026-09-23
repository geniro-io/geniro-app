import { describe, expect, it } from 'vitest';

import {
  followUpDelivery,
  type FollowUpFacts,
  PARKED_SEND_TITLE,
  parkedReason,
} from './follow-up-delivery';

const IDLE: FollowUpFacts = {
  streaming: false,
  queued: false,
  held: false,
  awaitingCalls: false,
  rootsIdle: false,
  subagentsOut: false,
  shellsOut: false,
};

/** A turn in flight with nothing parked — the agent producing its answer. */
const WORKING: FollowUpFacts = { ...IDLE, streaming: true };

// One case per row of the table in apps/ui/CLAUDE.md → "When a message queues".
describe('followUpDelivery — the table', () => {
  it('sends to an idle thread, which starts a turn', () => {
    expect(followUpDelivery(IDLE)).toEqual({ action: 'send' });
  });

  it('queues while the agent is producing its answer — a SYNC sub-agent included', () => {
    // A sync sub-agent is the agent's own tool call: the daemon no longer
    // announces it as background work, so nothing below is set and this is
    // the row it lands in. That is the reported case.
    expect(followUpDelivery(WORKING)).toEqual({
      action: 'queue',
      rule: 'agent-working',
      kickDrain: false,
    });
  });

  it.each([
    ['held', { held: true }],
    ['awaiting-calls', { awaitingCalls: true }],
    ['roots-idle', { rootsIdle: true }],
    ['background-subagents', { subagentsOut: true }],
    ['background-shells', { shellsOut: true }],
  ] as const)(
    'sends into a running thread whose agent is parked: %s',
    (_, parked) => {
      expect(followUpDelivery({ ...WORKING, ...parked })).toEqual({
        action: 'send',
      });
    },
  );

  it('queues behind an earlier message, whatever the agent is doing, and drives the drain', () => {
    expect(followUpDelivery({ ...IDLE, queued: true })).toEqual({
      action: 'queue',
      rule: 'behind-queue',
      kickDrain: true,
    });
    expect(
      followUpDelivery({ ...WORKING, subagentsOut: true, queued: true }),
    ).toEqual({ action: 'queue', rule: 'behind-queue', kickDrain: true });
  });

  it('never kicks the drain behind a WORKING agent — its turn ending does', () => {
    expect(followUpDelivery({ ...WORKING, queued: true })).toEqual({
      action: 'queue',
      rule: 'agent-working',
      kickDrain: false,
    });
  });
});

describe('parkedReason', () => {
  it('is null when nothing is parked', () => {
    expect(parkedReason(IDLE)).toBeNull();
  });

  it('names the first matching state, in the table order', () => {
    expect(parkedReason({ ...IDLE, held: true, shellsOut: true })).toBe('held');
    expect(parkedReason({ ...IDLE, subagentsOut: true, shellsOut: true })).toBe(
      'background-subagents',
    );
  });

  it('has a Send title for every state, each saying why it sends', () => {
    for (const title of Object.values(PARKED_SEND_TITLE)) {
      expect(title.startsWith('Send — ')).toBe(true);
    }
    expect(new Set(Object.values(PARKED_SEND_TITLE)).size).toBe(5);
  });
});
