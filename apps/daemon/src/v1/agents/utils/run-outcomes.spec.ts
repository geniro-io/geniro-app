import { describe, expect, it } from 'vitest';

import type { PullRequestOutcome } from '../chat.types';
import {
  parsePullRequestUrl,
  readRunOutcomes,
  withRunOutcome,
} from './run-outcomes';

const outcome = (
  seq: number,
  overrides: Partial<PullRequestOutcome> = {},
): PullRequestOutcome => ({
  seq,
  draft: true,
  reviewRounds: 1,
  acceptance: 'not_yet',
  questionsAsked: 0,
  ...overrides,
});

describe('parsePullRequestUrl', () => {
  it('reads owner, repo and number from a pull request page', () => {
    expect(
      parsePullRequestUrl('https://github.com/acme/platform/pull/7381'),
    ).toEqual({ owner: 'acme', repo: 'platform', number: 7381 });
  });

  it('reads the same identity through a sub-page, a fragment or surrounding spaces', () => {
    for (const url of [
      'https://github.com/acme/platform/pull/7381/files',
      'https://github.com/acme/platform/pull/7381#discussion_r12',
      'https://github.com/acme/platform/pull/7381?w=1',
      '  https://github.com/acme/platform/pull/7381  ',
    ]) {
      expect(parsePullRequestUrl(url)).toEqual({
        owner: 'acme',
        repo: 'platform',
        number: 7381,
      });
    }
  });

  it('refuses what is not a github.com pull request page', () => {
    for (const url of [
      'https://github.com/acme/platform/issues/7381',
      'https://github.com/acme/platform/pull/73a',
      'https://github.com/acme/platform/pull/0',
      'https://gitlab.com/acme/platform/pull/7381',
      'http://github.com/acme/platform/pull/7381',
      '#7381',
    ]) {
      expect(parsePullRequestUrl(url)).toBeNull();
    }
  });
});

describe('readRunOutcomes', () => {
  it('reads an empty map from a missing or unreadable column', () => {
    for (const raw of [null, undefined, '', '{', '[1]', 'null']) {
      expect(readRunOutcomes(raw).size).toBe(0);
    }
  });

  it('keeps readable entries and drops one with a field it cannot read', () => {
    const raw = JSON.stringify({
      'acme/platform#1': outcome(3),
      'acme/platform#2': { ...outcome(4), acceptance: 'maybe' },
      'acme/platform#3': { ...outcome(5), reviewRounds: 1.5 },
    });

    expect([...readRunOutcomes(raw).keys()]).toEqual(['acme/platform#1']);
  });
});

describe('withRunOutcome', () => {
  const pr = { owner: 'acme', repo: 'platform', number: 87 };

  it('records a newer outcome over an older one for the same pull request', () => {
    const first = withRunOutcome(null, pr, outcome(10));
    const second = withRunOutcome(
      first,
      pr,
      outcome(20, { acceptance: 'accepted' }),
    );

    expect(readRunOutcomes(second).get('acme/platform#87')).toEqual(
      outcome(20, { acceptance: 'accepted' }),
    );
  });

  it('never moves an outcome backwards to an older seq', () => {
    const newer = withRunOutcome(
      null,
      pr,
      outcome(20, { acceptance: 'accepted' }),
    );

    expect(
      readRunOutcomes(withRunOutcome(newer, pr, outcome(10))).get(
        'acme/platform#87',
      )?.seq,
    ).toBe(20);
  });

  it('files one pull request under one key whatever case its owner and repo are written in', () => {
    const lower = withRunOutcome(null, pr, outcome(10));
    const upper = withRunOutcome(
      lower,
      { owner: 'ACME', repo: 'Platform', number: 87 },
      outcome(20),
    );

    expect([...readRunOutcomes(upper).entries()]).toEqual([
      ['acme/platform#87', outcome(20)],
    ]);
  });

  it("keeps another pull request's outcome beside it", () => {
    const one = withRunOutcome(null, pr, outcome(10));
    const both = withRunOutcome(one, { ...pr, number: 88 }, outcome(11));

    expect([...readRunOutcomes(both).keys()].sort()).toEqual([
      'acme/platform#87',
      'acme/platform#88',
    ]);
  });
});
