import { describe, expect, it } from 'vitest';

import {
  isPullRequestCreateCall,
  MAX_RUN_PULL_REQUESTS,
  mergePullRequests,
  readPullRequestUrls,
  readRunPullRequests,
} from './pull-request-capture';

describe('readPullRequestUrls', () => {
  it('reads the URL gh prints on its own line', () => {
    expect(
      readPullRequestUrls('https://github.com/price-field-ai/platform/pull/87'),
    ).toEqual([
      {
        owner: 'price-field-ai',
        repo: 'platform',
        number: 87,
        url: 'https://github.com/price-field-ai/platform/pull/87',
      },
    ]);
  });

  it('finds it under the push output and the warning gh prints above it', () => {
    // The exact shape of a real result here: `git push` writes its remote block
    // and gh prefixes a warning, so the URL is neither the first line nor the
    // whole text.
    const result = [
      'remote: ',
      "remote: Create a pull request for 'fix/copy' on GitHub by visiting:        ",
      'remote:      https://github.com/price-field-ai/mobile-app/pull/new/fix/copy        ',
      'remote: ',
      'Warning: 2 uncommitted changes',
      'https://github.com/price-field-ai/mobile-app/pull/10',
    ].join('\n');
    expect(readPullRequestUrls(result).map((row) => row.number)).toEqual([10]);
  });

  it('does NOT read the push hint as a pull request', () => {
    // `…/pull/new/<branch>` is the "you could open one" link for a branch that
    // has none. Reading it as a pull request files a number that does not
    // exist under the thread, and it sits in the same text as the real URL.
    expect(
      readPullRequestUrls(
        'remote:      https://github.com/price-field-ai/ux-mockup/pull/new/feat/privacy',
      ),
    ).toEqual([]);
  });

  it('ignores a pull request on another host', () => {
    expect(
      readPullRequestUrls('https://git.example.com/acme/app/pull/3'),
    ).toEqual([]);
  });
});

describe('isPullRequestCreateCall', () => {
  it('is true for the command that opens one', () => {
    expect(
      isPullRequestCreateCall({
        command: 'cd /repo && gh pr create --base main --title "x"',
      }),
    ).toBe(true);
  });

  it('is FALSE for a command that merely reads one', () => {
    // The whole point of the pairing: `gh pr view` puts a pull request URL in a
    // tool result too, and that pull request belongs to whoever opened it.
    expect(
      isPullRequestCreateCall({ command: 'gh pr view 5161 --json url' }),
    ).toBe(false);
  });

  it('reads the command whatever key the CLI wrapped it in', () => {
    // The two transports hand geniro different tool-input shapes, and this must
    // not become a per-CLI branch.
    expect(
      isPullRequestCreateCall({ args: ['sh', '-c', 'gh pr create'] }),
    ).toBe(true);
  });

  it('is false for input that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(isPullRequestCreateCall(cyclic)).toBe(false);
  });
});

describe('mergePullRequests', () => {
  const pr = (number: number, seq: number, repo = 'platform') => ({
    owner: 'price-field-ai',
    repo,
    number,
    url: `https://github.com/price-field-ai/${repo}/pull/${number}`,
    seq,
  });

  it('keeps the EARLIEST sighting of the same pull request', () => {
    // A later `gh pr view` of the thread's own pull request must not move it to
    // the end of the list, which is ordered by when the thread opened them.
    const merged = mergePullRequests([pr(87, 10)], [pr(87, 900)]);
    expect(merged).toEqual([pr(87, 10)]);
  });

  it('tells the same number in two repositories apart', () => {
    // One thread routinely spans repositories, and `#3` means a different pull
    // request in each of them.
    const merged = mergePullRequests(
      [],
      [pr(3, 2, 'ux-mockup'), pr(3, 1, 'mobile-app')],
    );
    expect(merged.map((row) => row.repo)).toEqual(['mobile-app', 'ux-mockup']);
  });

  it('caps the list, keeping the oldest', () => {
    const many = Array.from({ length: MAX_RUN_PULL_REQUESTS + 5 }, (_, i) =>
      pr(i + 1, i),
    );
    const merged = mergePullRequests([], many);
    expect(merged).toHaveLength(MAX_RUN_PULL_REQUESTS);
    expect(merged[0]?.number).toBe(1);
  });
});

describe('readRunPullRequests', () => {
  it('reads back what was stored', () => {
    const rows = [
      {
        owner: 'a',
        repo: 'b',
        number: 1,
        url: 'https://github.com/a/b/pull/1',
        seq: 4,
      },
    ];
    expect(readRunPullRequests(JSON.stringify(rows))).toEqual(rows);
  });

  it('answers empty for a row that is not JSON, rather than throwing', () => {
    // This runs inside the chat-list projection: a throw here costs the whole
    // list, and the value is one thread's pull-request row.
    expect(readRunPullRequests('{ truncated')).toEqual([]);
  });

  it('drops an entry missing a field and keeps the rest', () => {
    const raw = JSON.stringify([
      { owner: 'a', repo: 'b', number: 1, url: 'u', seq: 0 },
      { owner: 'a', repo: 'b', url: 'u', seq: 1 },
    ]);
    expect(readRunPullRequests(raw).map((row) => row.number)).toEqual([1]);
  });
});
