import { describe, expect, it } from 'vitest';

import {
  marksResultText,
  readRecommendationMarks,
} from './mark-recommendations.reader';

describe('readRecommendationMarks', () => {
  it('reads an outcome per item and refuses an unknown status', () => {
    expect(
      readRecommendationMarks({
        cardSeq: 4,
        outcomes: [{ id: 'W-1', status: 'applied', backup: '.backups/x.yaml' }],
      }),
    ).toEqual({
      ok: true,
      query: {
        cardSeq: 4,
        outcomes: [{ id: 'W-1', status: 'applied', backup: '.backups/x.yaml' }],
      },
    });
    expect(
      readRecommendationMarks({
        cardSeq: 4,
        outcomes: [{ id: 'W-1', status: 'done' }],
      }).ok,
    ).toBe(false);
  });
});

describe('marksResultText', () => {
  it('words each outcome, and a refusal as an error', () => {
    expect(marksResultText({ status: 'recorded', seq: 9, count: 2 })).toEqual({
      text: '2 outcomes recorded on the card.',
      isError: false,
    });
    expect(
      marksResultText({ status: 'refused', reason: 'the card has no W-9' }),
    ).toEqual({ text: 'Not recorded: the card has no W-9.', isError: true });
  });
});
