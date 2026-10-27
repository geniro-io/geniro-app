import { describe, expect, it } from 'vitest';

import {
  readRecordOutcome,
  recordOutcomeResultText,
} from './record-outcome.reader';

const ARGS = {
  pr_number: 87,
  pr_url: 'https://github.com/acme/platform/pull/87',
  draft: true,
  review_rounds: 0,
  acceptance: 'not_yet',
};

describe('readRecordOutcome', () => {
  it('reads every field into the broker’s input', () => {
    expect(
      readRecordOutcome({
        ...ARGS,
        pr_url: '  https://github.com/acme/platform/pull/87 ',
        review_rounds: 2,
        acceptance: 'changes_requested',
      }),
    ).toEqual({
      prNumber: 87,
      prUrl: 'https://github.com/acme/platform/pull/87',
      draft: true,
      reviewRounds: 2,
      acceptance: 'changes_requested',
      summary: null,
    });
  });

  it('reads the summary trimmed, and a blank one as none', () => {
    expect(
      readRecordOutcome({ ...ARGS, summary: '  Retry moved behind a flag. ' }),
    ).toMatchObject({ summary: 'Retry moved behind a flag.' });
    expect(readRecordOutcome({ ...ARGS, summary: '   ' })).toMatchObject({
      summary: null,
    });
  });

  it('accepts each acceptance value', () => {
    for (const acceptance of [
      'accepted',
      'changes_requested',
      'not_yet',
      'not_needed',
    ]) {
      expect(readRecordOutcome({ ...ARGS, acceptance })).toMatchObject({
        acceptance,
      });
    }
  });

  it('refuses a missing field, an out-of-range number, an unknown acceptance and unknown arguments', () => {
    const error = (args: Record<string, unknown>): string => {
      const read = readRecordOutcome(args);
      if (!('error' in read)) {
        throw new Error(`expected a refusal for ${JSON.stringify(args)}`);
      }
      return read.error;
    };
    const { draft: _draft, ...withoutDraft } = ARGS;
    expect(error(withoutDraft)).toContain('draft');
    expect(error({ ...ARGS, pr_number: 0 })).toContain('pr_number');
    expect(error({ ...ARGS, pr_number: 8.5 })).toContain('pr_number');
    expect(error({ ...ARGS, review_rounds: -1 })).toContain('review_rounds');
    expect(error({ ...ARGS, pr_url: '  ' })).toContain('pr_url is empty');
    expect(
      error({ ...ARGS, pr_url: `${ARGS.pr_url}/${'x'.repeat(2048)}` }),
    ).toContain('pr_url is over 2048 characters');
    expect(error({ ...ARGS, acceptance: 'merged' })).toContain('acceptance');
    expect(error({ ...ARGS, summary: 'x'.repeat(1001) })).toContain(
      'summary is over 1000 characters',
    );
    expect(error({ ...ARGS, questions_asked: 3 })).toContain('questions_asked');
  });
});

describe('recordOutcomeResultText', () => {
  it('names the row and the questions geniro counted', () => {
    expect(
      recordOutcomeResultText({
        status: 'recorded',
        seq: 412,
        questionsAsked: 1,
      }),
    ).toBe(
      'Recorded as outcome 412 (1 question asked of the user on this run so far).',
    );
    expect(
      recordOutcomeResultText({
        status: 'recorded',
        seq: 412,
        questionsAsked: 3,
      }),
    ).toBe(
      'Recorded as outcome 412 (3 questions asked of the user on this run so far).',
    );
  });

  it('says it was not recorded when no pass could record it', () => {
    expect(
      recordOutcomeResultText({ status: 'unavailable', reason: 'no pass' }),
    ).toBe('Not recorded: no pass.');
  });
});
