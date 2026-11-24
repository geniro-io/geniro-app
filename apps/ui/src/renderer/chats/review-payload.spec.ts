import { describe, expect, it } from 'vitest';

import { readReviewPayload } from './review-payload';

const COMMENT = {
  number: 3,
  folder: '/work/shop',
  path: 'src/a.ts',
  side: 'new',
  startLine: 4,
  endLine: 5,
  quote: 'const a = 1;\nconst b = 2;',
  body: 'Merge these.',
};

describe('readReviewPayload', () => {
  it('reads the review a user message carried', () => {
    expect(
      readReviewPayload({ text: 'Review…', review: { note: 'Hi', comments: [COMMENT] } }),
    ).toEqual({ note: 'Hi', comments: [COMMENT] });
  });

  it('reads a whole-file comment with no lines', () => {
    const file = { ...COMMENT, side: 'file', startLine: null, endLine: null, quote: '' };
    expect(readReviewPayload({ review: { note: null, comments: [file] } })?.comments).toEqual([
      file,
    ]);
  });

  it('is null for an ordinary message', () => {
    expect(readReviewPayload({ text: 'hello' })).toBeNull();
  });

  it('is null when one comment is not the shape the daemon writes', () => {
    expect(
      readReviewPayload({
        review: { note: null, comments: [COMMENT, { ...COMMENT, side: 'left' }] },
      }),
    ).toBeNull();
  });
});
