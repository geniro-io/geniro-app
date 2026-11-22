import { describe, expect, it } from 'vitest';

import type { ChatRunTextMatch, RunPullRequestOutcomes } from '../chat.types';
import { doneMarksOf } from './pull-request-done-marks';

const ref = { owner: 'acme', repo: 'app', number: 8700 };

const row = (seq: number, text: string): ChatRunTextMatch => ({
  seq,
  member_id: 'senior',
  created_at: Date.parse('2026-11-20T09:00:00Z') + seq * 1000,
  text,
});

const outcomes: RunPullRequestOutcomes = {
  owner: 'acme',
  repo: 'app',
  number: 8700,
  url: 'https://github.com/acme/app/pull/8700',
  changesRequestedRounds: 0,
  msToAccepted: null,
  outcomes: [
    {
      seq: 90,
      at: '2026-11-20T10:00:00.000Z',
      draft: false,
      reviewRounds: 1,
      acceptance: 'accepted',
      questionsAsked: 0,
      summary: null,
      nodeId: 'manager',
    },
    {
      seq: 40,
      at: '2026-11-20T09:30:00.000Z',
      draft: true,
      reviewRounds: 0,
      acceptance: 'not_yet',
      questionsAsked: 0,
      summary: null,
      nodeId: 'manager',
    },
  ],
};

describe('doneMarksOf', () => {
  it('takes the first recorded outcome and every delivery block naming the pull request', () => {
    const marks = doneMarksOf(ref, outcomes, [
      row(
        12,
        'DONE CHECK\nPR: #8700 https://github.com/acme/app/pull/8700 · draft: yes',
      ),
      row(55, 'DELIVERY REPORT — #8700 is ready for review'),
    ]);

    expect(marks).toEqual([
      {
        seq: 12,
        at: '2026-11-20T09:00:12.000Z',
        source: 'done_check',
        memberId: 'senior',
      },
      {
        seq: 40,
        at: '2026-11-20T09:30:00.000Z',
        source: 'record_outcome',
        memberId: 'manager',
      },
      {
        seq: 55,
        at: '2026-11-20T09:00:55.000Z',
        source: 'delivery_report',
        memberId: 'senior',
      },
    ]);
  });

  it('leaves out a block about another pull request and prose that only mentions a done check', () => {
    const marks = doneMarksOf(ref, undefined, [
      row(3, 'DONE CHECK\nPR: #87001 https://github.com/acme/app/pull/87001'),
      row(4, 'DONE CHECK\nPR: #12 https://github.com/acme/app/pull/12'),
      row(5, 'the done check for #8700 is still missing'),
      row(6, 'DELIVERY REPORT for acme/app&#8700;'),
    ]);

    expect(marks).toEqual([]);
  });
});
