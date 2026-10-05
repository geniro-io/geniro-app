import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mainRepositoryOfWorktree } from './repository-root';

// `repositoryRootOf` is pinned through `claudeProjectKey`'s spec, which is its
// first reader and carries the probe it was transcribed from.

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'repository-root-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function dir(...segments: string[]): string {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A linked worktree of `repo`, laid out as `git worktree add` writes it. */
function worktree(repo: string, name: string): string {
  const tree = dir(name);
  const gitdir = dir(repo.slice(root.length + 1), '.git', 'worktrees', name);
  writeFileSync(join(tree, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(gitdir, 'gitdir'), `${join(tree, '.git')}\n`);
  return tree;
}

describe('mainRepositoryOfWorktree', () => {
  it('answers the main repository for a worktree, and for a folder inside one', async () => {
    const repo = dir('repo');
    dir('repo', '.git');
    const tree = worktree(repo, 'wt');
    const inside = dir('wt', 'apps', 'ui');

    await expect(mainRepositoryOfWorktree(tree)).resolves.toBe(repo);
    await expect(mainRepositoryOfWorktree(inside)).resolves.toBe(repo);
  });

  it('answers null for an ordinary checkout and its subfolders — they are not re-filed', async () => {
    // A home directory kept under git would otherwise swallow every project.
    dir('repo', '.git');
    const sub = dir('repo', 'packages', 'app');

    await expect(mainRepositoryOfWorktree(dir('repo'))).resolves.toBeNull();
    await expect(mainRepositoryOfWorktree(sub)).resolves.toBeNull();
  });

  it('answers null for a folder in no repository, or one that is gone', async () => {
    await expect(mainRepositoryOfWorktree(dir('plain'))).resolves.toBeNull();
    await expect(
      mainRepositoryOfWorktree(join(root, 'never-created')),
    ).resolves.toBeNull();
  });
});
