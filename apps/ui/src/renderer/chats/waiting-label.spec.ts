import { describe, expect, it } from 'vitest';

import { WAITING_LABEL_MAX_NAMES, waitingOnLabel } from './waiting-label';

describe('waitingOnLabel', () => {
  it('names EVERY agent a caller is waiting on', () => {
    // The reported defect: a manager that had briefed several agents said
    // `waiting on Engineer`, which is not a shorter way of naming three — it
    // names one and denies the others. The pin is that each of them is on the
    // line, so dropping back to the first would go red here.
    const label = waitingOnLabel([
      { callId: 'call-23', callee: 'Engineer' },
      { callId: 'call-24', callee: 'QA' },
      { callId: 'call-25', callee: 'Researcher' },
    ]);

    expect(label).toBe('waiting on Engineer, QA and Researcher');
  });

  it('keeps the call id while there is exactly one call', () => {
    // With one it is the handle for finding that block in a long transcript;
    // with several it is three times the text for what the blocks carry.
    expect(waitingOnLabel([{ callId: 'call-1', callee: 'Poet' }])).toBe(
      'waiting on Poet · call-1',
    );
    expect(
      waitingOnLabel([
        { callId: 'call-1', callee: 'Poet' },
        { callId: 'call-2', callee: 'Editor' },
      ]),
    ).not.toContain('call-1');
  });

  it('counts a repeated agent instead of naming it twice', () => {
    // One agent asked twice is one agent being waited on. "Engineer and
    // Engineer" reads as a bug; the count is the fact the repetition carries.
    expect(
      waitingOnLabel([
        { callId: 'call-1', callee: 'Engineer' },
        { callId: 'call-2', callee: 'Engineer' },
        { callId: 'call-3', callee: 'QA' },
      ]),
    ).toBe('waiting on Engineer ×2 and QA');
  });

  it('counts the overflow rather than dropping it', () => {
    // The row shares its line with a clock and a token bill, so a fan-out of a
    // dozen cannot be spelled out — but the phrase must never imply the list is
    // shorter than it is, which is the whole defect this helper exists for.
    const label = waitingOnLabel(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((callee, i) => ({
        callId: `call-${i}`,
        callee,
      })),
    );

    expect(label).toBe(`waiting on A, B, C, D and 2 more`);
    expect(WAITING_LABEL_MAX_NAMES).toBe(4);
  });

  it('says nothing when nothing is open, and names an agent it cannot name', () => {
    expect(waitingOnLabel([])).toBeNull();
    expect(waitingOnLabel([{ callId: 'call-9', callee: null }])).toBe(
      'waiting on a called agent · call-9',
    );
  });
});
