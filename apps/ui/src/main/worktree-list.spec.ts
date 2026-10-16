import { describe, expect, it, vi } from 'vitest';

import { parseWorktreeList, readWorktreeEntries } from './worktree-list';

const RECORDS = [
  'worktree /repo',
  'HEAD 1111111111111111111111111111111111111111',
  'branch refs/heads/main',
  '',
  'worktree /repo/wt',
  'HEAD 2222222222222222222222222222222222222222',
  'detached',
  'prunable gitdir file points to non-existent location',
  '',
];

const PARSED = [
  { path: '/repo', branch: 'refs/heads/main', prunable: false },
  { path: '/repo/wt', branch: null, prunable: true },
];

describe('parseWorktreeList', () => {
  it('reads each record in git’s order, with its branch and prunable mark', () => {
    expect(parseWorktreeList([...RECORDS, ''].join('\0'))).toEqual(PARSED);
  });

  it('keeps a path holding a newline or ending in a space as one path', () => {
    const listing = ['worktree /repo/odd\nname ', 'detached', '', ''].join(
      '\0',
    );

    expect(parseWorktreeList(listing).map((entry) => entry.path)).toEqual([
      '/repo/odd\nname ',
    ]);
  });

  it('reads the newline framing the same way', () => {
    expect(parseWorktreeList(RECORDS.join('\n'), '\n')).toEqual(PARSED);
  });
});

describe('readWorktreeEntries', () => {
  const gitOf =
    (version: string) =>
    async (args: string[]): Promise<string | null> => {
      if (args.includes('-z')) {
        return null;
      }
      return args[0] === 'version' ? version : `${RECORDS.join('\n')}\n`;
    };

  it('falls back to the newline framing on a git that does not know `-z`', async () => {
    // git before 2.36: `worktree list -z` fails, the plain listing answers.
    expect(await readWorktreeEntries(gitOf('git version 2.35.1\n'))).toEqual(
      PARSED,
    );
  });

  it('does not run the listing again when `-z` failed on a git that knows it', async () => {
    // A timeout or a missing folder would only fail a second time, after a
    // second timeout.
    const run = vi.fn(gitOf('git version 2.39.5 (Apple Git-154)\n'));

    expect(await readWorktreeEntries(run)).toBeNull();
    expect(run.mock.calls.map(([args]) => args.join(' '))).toEqual([
      'worktree list --porcelain -z',
      'version',
    ]);
  });

  it('answers null when git answers nothing', async () => {
    expect(await readWorktreeEntries(async () => null)).toBeNull();
  });
});
