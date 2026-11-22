import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every case here drives several real git subprocesses against a temp repo. */
export const TIMEOUT_MS = 30_000;

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A clean git checkout at `path`, holding one committed file.
 *
 * The containment cases below need a directory `git status` can ANSWER for:
 * against a non-repo directory `isDirty` reports "unconfirmable", which every
 * caller reads as "leave it alone" — so the delete is refused by that guard
 * and the containment check the case is named for is never reached.
 */
export const cleanRepoAt = (path: string, file: string): void => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.email', 'spec@example.com');
  git(path, 'config', 'user.name', 'Spec');
  writeFileSync(join(path, file), 'do not delete\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'committed');
};

export const makeFixtureRepo = (): { userData: string; repo: string } => {
  const userData = realpathSync(
    mkdtempSync(join(tmpdir(), 'geniro-worktree-ud-')),
  );
  const repo = realpathSync(
    mkdtempSync(join(tmpdir(), 'geniro-worktree-repo-')),
  );
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'spec@example.com');
  git(repo, 'config', 'user.name', 'Spec');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  return { userData, repo };
};

export const removeFixtureRepo = (fixture: {
  userData: string;
  repo: string;
}): void => {
  rmSync(fixture.userData, { recursive: true, force: true });
  rmSync(fixture.repo, { recursive: true, force: true });
};

export const registerRowIn = (
  userData: string,
  repo: string,
  path: string,
): void => {
  writeFileSync(
    join(userData, 'worktrees.json'),
    JSON.stringify([
      { taskId: 't1', path, branch: 'b', folder: repo, createdAt: '' },
    ]),
  );
};

/** The daemon's answer for a reaper pass: every card named is finished. */
export const allFinished = (taskIds: string[]): Promise<ReadonlySet<string>> =>
  Promise.resolve(new Set(taskIds));

/** The daemon's answer for a reaper pass: no card named is finished. */
export const noneFinished = (): Promise<ReadonlySet<string>> =>
  Promise.resolve(new Set<string>());
