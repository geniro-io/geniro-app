import { describe, expect, it } from 'vitest';

import { parseRunOutcomePayload } from './run-outcome-payload';

const OUTCOME = {
  prOwner: 'geniro-io',
  prRepo: 'geniro-app',
  prNumber: 7,
  prUrl: 'https://github.com/geniro-io/geniro-app/pull/7',
  draft: false,
  reviewRounds: 1,
  acceptance: 'accepted',
  questionsAsked: 0,
  nodeId: 'engineer',
  conversationId: null,
};

describe('parseRunOutcomePayload', () => {
  it('reads a row recorded before the rename, which names the team workflowSlug', () => {
    const parsed = parseRunOutcomePayload({
      ...OUTCOME,
      workflowSlug: 'dev-team',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.teamSlug).toBe('dev-team');
  });

  it('reads a row recorded today as it is', () => {
    const parsed = parseRunOutcomePayload({ ...OUTCOME, teamSlug: null });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.teamSlug).toBeNull();
  });
});
