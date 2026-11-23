import { describe, expect, it } from 'vitest';

import {
  NEAR_DUPLICATE_SIMILARITY,
  nearDuplicate,
  nearDuplicateCandidatesQuery,
  textSimilarity,
} from './memory-duplicates';

function words(from: number, count: number): string {
  return Array.from({ length: count }, (_, n) => `word${from + n}x`).join(' ');
}

const BODY =
  'The pull request editor fails on this organisation because projects classic is deprecated; patch the description through the REST endpoint instead.';

describe('textSimilarity', () => {
  it('is 1 for the same words in another order', () => {
    expect(
      textSimilarity(
        { title: 'alpha beta', body: 'gamma delta' },
        { title: 'delta gamma', body: 'beta alpha' },
      ),
    ).toEqual({ shared: 4, cosine: 1 });
  });

  it('is 0 when a side has no word long enough to count', () => {
    expect(
      textSimilarity(
        { title: 'a b', body: 'to 12' },
        { title: 'a b', body: 'to 12' },
      ),
    ).toEqual({ shared: 0, cosine: 0 });
    expect(
      nearDuplicate({ title: 'a b', body: 'c' }, { title: 'a b', body: 'c' }),
    ).toBe(false);
  });
});

describe('nearDuplicate', () => {
  it('counts a note at the threshold as a duplicate and one word less as not', () => {
    const left = { title: 'x', body: words(0, 50) };
    const at = { title: 'x', body: `${words(0, 21)} ${words(100, 29)}` };
    const under = { title: 'x', body: `${words(0, 20)} ${words(100, 30)}` };

    expect(textSimilarity(left, at).cosine).toBeCloseTo(
      NEAR_DUPLICATE_SIMILARITY,
      10,
    );
    expect(nearDuplicate(left, at)).toBe(true);
    expect(nearDuplicate(left, under)).toBe(false);
  });

  it('needs enough words in common, however short both notes are', () => {
    const left = { title: 'Global kiwi', body: 'mango' };

    expect(nearDuplicate(left, { title: 'Project kiwi', body: 'mango' })).toBe(
      false,
    );
    expect(nearDuplicate(left, { title: 'Global kiwi', body: 'mango' })).toBe(
      true,
    );
  });

  it('catches a reworded title over the same body', () => {
    expect(
      nearDuplicate(
        { title: 'gh pr edit fails here, use the REST API', body: BODY },
        { title: 'Editing pull requests needs a workaround', body: BODY },
      ),
    ).toBe(true);
  });

  it('lets the same title over a different body through', () => {
    expect(
      nearDuplicate(
        { title: 'How to restart the local stand', body: BODY },
        {
          title: 'How to restart the local stand',
          body: 'Stop every process the stand started in its worktree, wait for the ports to close, then boot it again from its pointer note with the same port slot.',
        },
      ),
    ).toBe(false);
  });
});

describe('nearDuplicateCandidatesQuery', () => {
  it('searches the title words first, then the longest body words', () => {
    expect(
      nearDuplicateCandidatesQuery({
        title: 'Zeta note',
        body: 'medium extraordinary tiny',
      }),
    ).toBe('"note"* OR "zeta"* OR "extraordinary"* OR "medium"* OR "tiny"*');
  });

  it('caps the words it searches by', () => {
    const query = nearDuplicateCandidatesQuery({
      title: 'x',
      body: words(0, 100),
    });

    expect(query?.split(' OR ')).toHaveLength(64);
  });

  it('is null when the note has no word to search by', () => {
    expect(
      nearDuplicateCandidatesQuery({ title: 'a', body: 'b 42' }),
    ).toBeNull();
  });
});
