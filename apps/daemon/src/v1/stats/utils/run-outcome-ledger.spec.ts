import { describe, expect, it } from 'vitest';

import type { RunPullRequestOutcomes } from '../../agents/chat.types';
import type { RunOutcomeLedgerRow } from '../stats.types';
import { withHistory } from './run-outcome-ledger';

const ROW: RunOutcomeLedgerRow = {
  runId: 'run-1',
  sourceSeq: 40,
  occurredAt: new Date('2026-10-27T10:00:00.000Z'),
  workflowSlug: 'dev-team',
  prOwner: 'Acme',
  prRepo: 'platform',
  prNumber: 87,
  prUrl: 'https://github.com/Acme/platform/pull/87',
  draft: false,
  reviewRounds: 2,
  acceptance: 'accepted',
  questionsAsked: 0,
  changesRequestedRounds: null,
  msToAccepted: null,
};

const HISTORY: RunPullRequestOutcomes = {
  owner: 'acme',
  repo: 'platform',
  number: 87,
  url: 'https://github.com/acme/platform/pull/87',
  changesRequestedRounds: 1,
  msToAccepted: 60_000,
  outcomes: [
    {
      seq: 40,
      at: '2026-10-27T10:00:00.000Z',
      draft: false,
      reviewRounds: 2,
      acceptance: 'accepted',
      questionsAsked: 3,
      summary: null,
      nodeId: 'manager',
    },
  ],
};

describe('withHistory', () => {
  it('takes the history figures and the recounted questions of its own pull request and row', () => {
    expect(withHistory(ROW, [HISTORY])).toEqual({
      ...ROW,
      questionsAsked: 3,
      changesRequestedRounds: 1,
      msToAccepted: 60_000,
    });
  });

  it('leaves the row uncounted when the history no longer holds it', () => {
    expect(withHistory(ROW, [])).toEqual(ROW);
    expect(
      withHistory(ROW, [
        { ...HISTORY, outcomes: [{ ...HISTORY.outcomes[0]!, seq: 39 }] },
      ]),
    ).toEqual(ROW);
  });
});
