import { describe, expect, it } from 'vitest';

import { readRunOutcomePayload } from './run-outcome-payload';

const PAYLOAD = {
  prOwner: 'acme',
  prRepo: 'platform',
  prNumber: 87,
  prUrl: 'https://github.com/acme/platform/pull/87',
  draft: false,
  reviewRounds: 1,
  acceptance: 'not_needed',
  questionsAsked: 0,
  workflowSlug: 'dev-team',
  nodeId: 'manager',
  conversationId: null,
  callId: 'call-2',
};

describe('readRunOutcomePayload', () => {
  it('reads the daemon’s payload into the row’s fields', () => {
    expect(readRunOutcomePayload(PAYLOAD)).toEqual({
      prOwner: 'acme',
      prRepo: 'platform',
      prNumber: 87,
      prUrl: 'https://github.com/acme/platform/pull/87',
      draft: false,
      reviewRounds: 1,
      acceptance: 'not_needed',
      questionsAsked: 0,
      nodeId: 'manager',
    });
  });

  it('reads nothing from a payload missing or mistyping a field it draws', () => {
    for (const broken of [
      null,
      'outcome',
      { ...PAYLOAD, acceptance: 'merged' },
      { ...PAYLOAD, draft: 'no' },
      { ...PAYLOAD, reviewRounds: -1 },
      { ...PAYLOAD, questionsAsked: 1.5 },
      { ...PAYLOAD, prNumber: undefined },
    ]) {
      expect(readRunOutcomePayload(broken)).toBeNull();
    }
  });
});
