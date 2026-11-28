import { describe, expect, it } from 'vitest';

import {
  commandOf,
  isCompactionRow,
  resultCharsOf,
  skillOf,
} from './usage-observation';

describe('commandOf', () => {
  it.each([
    ['/review foo --deep', 'review'],
    ['  /geniro:plan the thing', 'geniro:plan'],
    ['/loop', 'loop'],
    ['/compact', null],
    ['/compact keep the plan', null],
    ['/Users/x/y.ts is broken', null],
    ['/usr/bin/env', null],
    ['/9lives', null],
    ['look at /review', null],
    ['', null],
  ])('%j → %j', (text, expected) => {
    expect(commandOf(text)).toBe(expected);
  });
});

describe('skillOf', () => {
  it.each([
    ['Skill', { skill: 'geniro:review', args: 'secret' }, 'geniro:review'],
    ['Skill', { skill: 'has space' }, null],
    ['Skill', { skill: 7 }, null],
    ['Skill', undefined, null],
    ['Read', { skill: 'geniro:review' }, null],
  ])('%s %j → %j', (name, input, expected) => {
    expect(skillOf(name, input)).toBe(expected);
  });
});

describe('resultCharsOf', () => {
  it.each([
    ['plain text', 10],
    [
      [
        { type: 'text', text: 'abc' },
        { type: 'image' },
        { type: 'text', text: 'de' },
      ],
      5,
    ],
    [{ content: [{ type: 'text', text: 'four' }] }, 4],
    [[{ type: 'image' }], null],
    [{ ok: true }, null],
    [null, null],
  ])('%j → %j', (result, expected) => {
    expect(resultCharsOf(result)).toBe(expected);
  });
});

describe('isCompactionRow', () => {
  it.each([
    [{ compaction: { trigger: 'auto' } }, true],
    [{ compaction: null }, false],
    [{ compaction: false }, false],
    [{ message: 'x' }, false],
    [null, false],
  ])('%j → %s', (payload, expected) => {
    expect(isCompactionRow(payload)).toBe(expected);
  });
});
