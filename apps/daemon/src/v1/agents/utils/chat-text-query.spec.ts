import { describe, expect, it } from 'vitest';

import {
  chatTextMatchQuery,
  chatTextQueryTerms,
  matchEveryWordElseAny,
} from './chat-text-query';

describe('chatTextMatchQuery', () => {
  it('turns each word into a quoted prefix term, all required', () => {
    expect(chatTextMatchQuery('платеж stripe')).toBe('"платеж"* AND "stripe"*');
  });

  it('quotes FTS5 syntax as text and doubles an inner quote', () => {
    expect(chatTextMatchQuery('NEAR(a "b" col:c')).toBe(
      '"NEAR(a" AND """b""" AND "col:c"',
    );
  });

  it('groups words joined by a bare uppercase OR, so the rest stay required', () => {
    expect(chatTextMatchQuery('idempotency retry OR backoff')).toBe(
      '"idempotency"* AND ("retry"* OR "backoff"*)',
    );
    expect(chatTextMatchQuery('OR retry OR OR backoff OR')).toBe(
      '("retry"* OR "backoff"*)',
    );
    expect(chatTextMatchQuery('retry or backoff')).toBe(
      '"retry"* AND "or"* AND "backoff"*',
    );
  });

  it('matches a one-character word as itself, not as every word it begins', () => {
    expect(chatTextMatchQuery('x retry')).toBe('"x" AND "retry"*');
    expect(chatTextMatchQuery('я')).toBe('"я"');
    expect(chatTextMatchQuery('C# a- C++')).toBe('"C#" AND "a-" AND "C++"');
    expect(chatTextMatchQuery('a-bc')).toBe('"a-bc"*');
  });

  it('drops words with nothing to index, and answers null when none are left', () => {
    expect(chatTextMatchQuery('-- !! fix')).toBe('"fix"*');
    expect(chatTextMatchQuery('— … ?? OR')).toBeNull();
  });
});

describe('chatTextQueryTerms', () => {
  it('splits words the way the index does, lowercased, without OR', () => {
    expect(chatTextQueryTerms('Foo-Bar OR платеж -- x')).toEqual([
      'foo',
      'bar',
      'платеж',
      'x',
    ]);
  });
});

describe('matchEveryWordElseAny', () => {
  const recording = (answers: string[][]) => {
    const asked: string[] = [];
    const match = async (query: string) => {
      asked.push(query);
      return answers[asked.length - 1] ?? [];
    };
    return { asked, match };
  };

  it('asks once with every word required when that finds something', async () => {
    const { asked, match } = recording([['hit']]);

    expect(await matchEveryWordElseAny('alpha beta', match)).toEqual(['hit']);
    expect(asked).toEqual(['"alpha"* AND "beta"*']);
  });

  it('asks again with any word when every word finds nothing', async () => {
    const { asked, match } = recording([[], ['partial']]);

    expect(await matchEveryWordElseAny('Alpha beta-gamma', match)).toEqual([
      'partial',
    ]);
    expect(asked).toEqual([
      '"Alpha"* AND "beta-gamma"*',
      '("alpha"* OR "beta"* OR "gamma"*)',
    ]);
  });

  it('asks again without one-character words when they made the first query miss', async () => {
    const { asked, match } = recording([[], ['partial']]);

    expect(await matchEveryWordElseAny('alpha x', match)).toEqual(['partial']);
    expect(asked).toEqual(['"alpha"* AND "x"', '"alpha"*']);
  });

  it('does not ask the same query twice', async () => {
    const lone = recording([[], ['never']]);
    expect(await matchEveryWordElseAny('alpha', lone.match)).toEqual([]);
    expect(lone.asked).toEqual(['"alpha"*']);

    const either = recording([[], ['never']]);
    expect(await matchEveryWordElseAny('alpha OR beta', either.match)).toEqual(
      [],
    );
    expect(either.asked).toEqual(['("alpha"* OR "beta"*)']);

    const single = recording([[], ['never']]);
    expect(await matchEveryWordElseAny('x', single.match)).toEqual([]);
    expect(single.asked).toEqual(['"x"']);
  });

  it('asks nothing when no word is searchable', async () => {
    const { asked, match } = recording([['never']]);

    expect(await matchEveryWordElseAny('-- !!', match)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
