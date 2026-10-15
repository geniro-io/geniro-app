import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { gitFailureLine } from './git-failure';

const execFileAsync = promisify(execFile);

let dir = '';

afterEach(() => {
  if (dir !== '') {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

/** The rejection a real failed git call produces, stderr and all. */
const failureOf = async (cwd: string, args: string[]): Promise<unknown> => {
  try {
    await execFileAsync('git', args, { cwd });
  } catch (error) {
    return error;
  }
  throw new Error(`git ${args.join(' ')} did not fail`);
};

describe('gitFailureLine', () => {
  it('names why `worktree add` failed, not the progress line git printed first', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-git-failure-')));
    const repo = join(dir, 'repo');
    await execFileAsync('git', ['init', '-q', '-b', 'main', repo]);
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Spec',
        '-c',
        'user.email=spec@example.com',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'first',
      ],
      { cwd: repo },
    );
    await execFileAsync('git', ['worktree', 'add', '-q', '-b', 'tb', '../a'], {
      cwd: repo,
    });

    const failure = await failureOf(repo, ['worktree', 'add', '../b', 'tb']);

    // The genuine stderr opens with the progress line this used to show.
    expect(String((failure as { stderr: unknown }).stderr)).toMatch(
      /^Preparing worktree/,
    );
    expect(gitFailureLine(failure, 'fallback')).toMatch(
      /^fatal: 'tb' is already used by worktree at /,
    );
  }, 30_000);

  it('falls back to the last line when git wrote no fatal or error', () => {
    const failure = Object.assign(new Error('Command failed'), {
      stderr: 'Preparing worktree\nsomething went wrong\n',
    });

    expect(gitFailureLine(failure, 'fallback')).toBe('something went wrong');
  });

  it('answers the fallback when the failure carries no stderr', () => {
    expect(gitFailureLine(new Error('spawn git ENOENT'), 'git failed')).toBe(
      'git failed',
    );
    expect(
      gitFailureLine(Object.assign(new Error('x'), { stderr: '' }), 'empty'),
    ).toBe('empty');
  });
});
