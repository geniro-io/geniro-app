import { describe, expect, it } from 'vitest';

import { memoryBodyOf, ruleOfLessonBody } from './lesson-body';

const SOURCE = {
  why: 'The same check failed three times.',
  sourceTitle: 'Migrate the cache',
  evidenceSeq: 6,
  evidenceQuote: 'use pnpm not npm',
};

describe('ruleOfLessonBody', () => {
  it('reads back the rule a lesson body was built from', () => {
    const rule = 'Change what a failing check exercises.\nThen rerun it.';

    expect(ruleOfLessonBody(memoryBodyOf(SOURCE, rule))).toBe(rule);
    expect(
      ruleOfLessonBody(memoryBodyOf({ ...SOURCE, sourceTitle: null }, rule)),
    ).toBe(rule);
  });

  it('leaves a body that is no lesson whole', () => {
    const body = 'Use pnpm.\n\nWhy: npm breaks the lockfile.';

    expect(ruleOfLessonBody(body)).toBe(body);
  });
});
