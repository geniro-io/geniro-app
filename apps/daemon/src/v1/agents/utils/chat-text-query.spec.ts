import { describe, expect, it } from 'vitest';

import { chatTextMatchQuery, chatTextQueryTerms } from './chat-text-query';

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
