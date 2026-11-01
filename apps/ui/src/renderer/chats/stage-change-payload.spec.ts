import { describe, expect, it } from 'vitest';

import { readStageActor, readStageChangePayload } from './stage-change-payload';

const PAYLOAD = {
  action: 'complete',
  stageId: 'review',
  stageTitle: 'Review',
  next: 'ship',
  text: 'two rounds, all threads resolved',
  rev: 3,
  by: { kind: 'agent', nodeId: 'manager', callId: 'call-2' },
};

describe('readStageChangePayload', () => {
  it('reads the daemon’s payload into the row’s fields', () => {
    expect(readStageChangePayload(PAYLOAD)).toEqual(PAYLOAD);
  });

  it.each(['complete', 'skip', 'reopen', 'nudge', 'stalled', 'handoff'])(
    'admits the %s action',
    (action) => {
      expect(readStageChangePayload({ ...PAYLOAD, action })?.action).toBe(
        action,
      );
    },
  );

  it('reads a hand-off’s new lead, and refuses one that is not a string', () => {
    const handoff = {
      ...PAYLOAD,
      action: 'handoff',
      by: { kind: 'system' },
      lead: 'reviewer',
    };
    expect(readStageChangePayload(handoff)?.lead).toBe('reviewer');
    expect(readStageChangePayload({ ...handoff, lead: 7 })).toBeNull();
    expect(readStageChangePayload(PAYLOAD)).not.toHaveProperty('lead');
  });

  it('leaves `next` out when the move named none', () => {
    const { next: _next, ...bare } = PAYLOAD;
    expect(readStageChangePayload(bare)).not.toHaveProperty('next');
  });

  it('reads nothing from a payload missing or mistyping a field it draws', () => {
    for (const broken of [
      null,
      'stage',
      { ...PAYLOAD, action: 'finish' },
      { ...PAYLOAD, stageTitle: undefined },
      { ...PAYLOAD, text: 4 },
      { ...PAYLOAD, rev: 1.5 },
      { ...PAYLOAD, next: 7 },
      { ...PAYLOAD, by: { kind: 'robot' } },
      { ...PAYLOAD, by: undefined },
    ]) {
      expect(readStageChangePayload(broken)).toBeNull();
    }
  });
});

describe('readStageActor', () => {
  it('reads each of the three actors', () => {
    expect(readStageActor({ kind: 'agent', nodeId: 'a' })).toEqual({
      kind: 'agent',
      nodeId: 'a',
    });
    expect(readStageActor({ kind: 'user', via: 'remote' })).toEqual({
      kind: 'user',
      via: 'remote',
    });
    expect(readStageActor({ kind: 'system' })).toEqual({ kind: 'system' });
  });

  it('refuses an agent without a node, a user without a known channel, and a non-string call id', () => {
    expect(readStageActor({ kind: 'agent' })).toBeNull();
    expect(readStageActor({ kind: 'user', via: 'carrier-pigeon' })).toBeNull();
    expect(
      readStageActor({ kind: 'agent', nodeId: 'a', callId: 3 }),
    ).toBeNull();
    expect(readStageActor(null)).toBeNull();
  });
});
