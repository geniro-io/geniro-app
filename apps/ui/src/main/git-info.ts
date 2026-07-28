import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { BranchSwitchResult, GitInfo } from '../shared/contracts';

const execFileAsync = promisify(execFile);

/** No git call may hang the composer's chip render. */
const GIT_TIMEOUT_MS = 5000;

const NOT_A_REPO: GitInfo = {
  isRepo: false,
  branch: null,
  branches: [],
  dirty: false,
};

/**
 * Run one git command in `cwd`. Never throws: a missing binary, a non-repo
 * directory and a failed subcommand are all "no answer" to a caller that only
 * wants to decide whether to show a chip.
 */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      // A repo with thousands of branches must not blow up the IPC payload.
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Describe the git state of a folder for the composer's branch chip.
 *
 * A detached HEAD reports `branch: null` — there is no branch to name, and
 * claiming one ("HEAD") would put a bogus entry in the picker.
 */
export async function readGitInfo(dir: string): Promise<GitInfo> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    return NOT_A_REPO;
  }
  const [head, refs, status] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git(dir, ['status', '--porcelain']),
  ]);
  return {
    isRepo: true,
    branch: head === null || head === 'HEAD' ? null : head,
    branches: refs === null || refs === '' ? [] : refs.split('\n'),
    // `null` = the status call itself failed; treating that as clean would let
    // a checkout run without the guard ever having looked.
    dirty: status === null || status !== '',
  };
}

/**
 * Switch `dir` to `branch`, but never over uncommitted work.
 *
 * The dirty check is re-run here rather than trusted from the renderer's last
 * {@link readGitInfo}: that snapshot can be seconds old, and the whole point of
 * the guard is that the tree may have changed since the chip was drawn.
 */
export async function switchBranch(
  dir: string,
  branch: string,
): Promise<BranchSwitchResult> {
  const info = await readGitInfo(dir);
  if (!info.isRepo) {
    return { ok: false, branch: null, error: 'Not a git repository' };
  }
  if (info.branch === branch) {
    return { ok: true, branch, error: null };
  }
  if (info.dirty) {
    return {
      ok: false,
      branch: info.branch,
      error: 'Uncommitted changes — commit or stash them first',
    };
  }
  try {
    // `switch`, never `checkout`: checkout resolves its argument as a branch OR
    // a pathspec, so in a repo holding a file named like the branch it would
    // RESTORE THAT FILE instead of switching — silently discarding edits. And
    // `git checkout -- <name>` is unambiguously the file form, not the branch
    // form. `switch` only ever means a branch. execFile takes an argv array, so
    // there is no shell to inject into either.
    await execFileAsync('git', ['switch', branch], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : '';
    return {
      ok: false,
      branch: info.branch,
      error: stderr === '' ? 'git switch failed' : stderr.split('\n')[0]!,
    };
  }
  return { ok: true, branch, error: null };
}
