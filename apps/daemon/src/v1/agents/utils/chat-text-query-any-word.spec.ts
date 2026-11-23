import { describe, expect, it } from 'vitest';

import {
  anyWordMatchQuery,
  chatTextMatchQuery,
  matchEveryWordElseAny,
} from './chat-text-query';

describe('anyWordMatchQuery', () => {
  it('joins the words as alternatives, never as a conjunction', () => {
    expect(anyWordMatchQuery('idempotency retry backoff')).toBe(
      '("idempotency"* OR "retry"* OR "backoff"*)',
    );
    expect(chatTextMatchQuery('alpha beta')).toBe('"alpha"* AND "beta"*');
    expect(anyWordMatchQuery('alpha beta')).toBe('("alpha"* OR "beta"*)');
  });

  it('answers a single word as its prefix term', () => {
    expect(anyWordMatchQuery('zebra')).toBe('"zebra"*');
  });

  it('leaves out one-character words', () => {
    expect(anyWordMatchQuery('zebra x')).toBe('"zebra"*');
    expect(anyWordMatchQuery('a b')).toBeNull();
    expect(anyWordMatchQuery('')).toBeNull();
  });

  it('splits punctuated words the way the index tokenizes them', () => {
    expect(anyWordMatchQuery('foo-bar')).toBe('("foo"* OR "bar"*)');
  });

  it('keeps Cyrillic words and drops the uppercase OR operator', () => {
    expect(anyWordMatchQuery('платеж')).toBe('"платеж"*');
    expect(anyWordMatchQuery('say "hi" OR there')).toBe(
      '("say"* OR "hi"* OR "there"*)',
    );
  });
});

describe('matchEveryWordElseAny', () => {
  it('asks the any-word query only when every word finds nothing', async () => {
    const asked: string[] = [];
    const found = await matchEveryWordElseAny('alpha beta', async (query) => {
      asked.push(query);
      return query.includes('OR') ? ['hit'] : [];
    });

    expect(found).toEqual(['hit']);
    expect(asked).toEqual(['"alpha"* AND "beta"*', '("alpha"* OR "beta"*)']);
  });

  it('keeps the every-word matches and asks nothing more when they exist', async () => {
    const asked: string[] = [];
    const found = await matchEveryWordElseAny('alpha beta', async (query) => {
      asked.push(query);
      return ['exact'];
    });

    expect(found).toEqual(['exact']);
    expect(asked).toEqual(['"alpha"* AND "beta"*']);
  });
});
