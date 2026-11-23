import { describe, expect, it } from 'vitest';

import { readMilestonePayload } from './milestone-payload';

const PAYLOAD = {
  text: 'Wrote the timeline route; the events query is next.',
  kind: 'progress',
  nodeId: 'engineer',
  conversationId: null,
};

describe('readMilestonePayload', () => {
  it('reads the daemon’s payload into the step’s fields', () => {
    expect(readMilestonePayload(PAYLOAD)).toEqual(PAYLOAD);
  });

  it.each(['progress', 'problem', 'done'])('admits the %s kind', (kind) => {
    expect(readMilestonePayload({ ...PAYLOAD, kind })?.kind).toBe(kind);
  });

  it('reads the call a step was written in, and leaves it out when there was none', () => {
    const called = { ...PAYLOAD, conversationId: 'call-3', callId: 'call-3' };
    expect(readMilestonePayload(called)?.callId).toBe('call-3');
    expect(readMilestonePayload(called)?.conversationId).toBe('call-3');
    expect(readMilestonePayload(PAYLOAD)).not.toHaveProperty('callId');
  });

  it('refuses a call id that is not a string', () => {
    expect(readMilestonePayload({ ...PAYLOAD, callId: 7 })).toBeNull();
  });

  it('refuses a conversation that is neither a string nor null', () => {
    const { conversationId: _omitted, ...bare } = PAYLOAD;
    expect(readMilestonePayload(bare)).toBeNull();
    expect(readMilestonePayload({ ...PAYLOAD, conversationId: 3 })).toBeNull();
  });

  it('reads nothing from a payload missing or mistyping a field it draws', () => {
    for (const broken of [
      null,
      'progress',
      { ...PAYLOAD, kind: 'finish' },
      { ...PAYLOAD, text: '' },
      { ...PAYLOAD, text: '   ' },
      { ...PAYLOAD, text: 4 },
      { ...PAYLOAD, nodeId: undefined },
    ]) {
      expect(readMilestonePayload(broken)).toBeNull();
    }
  });
});
