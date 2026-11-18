import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../__tests__/temp-dir';
import { isFolderGone, movedFolderOf } from './turn-folder';

function folder(...segments: string[]): string {
  const path = join(...segments);
  mkdirSync(path, { recursive: true });
  return realpathSync(path);
}

describe('isFolderGone', () => {
  it('is true only for an absolute path with nothing on disk', () => {
    const root = folder(tempDir('turn-folder-'));
    expect(isFolderGone(root)).toBe(false);
    expect(isFolderGone(join(root, 'deleted'))).toBe(true);
    expect(isFolderGone('relative/deleted')).toBe(false);
  });
});

describe('movedFolderOf', () => {
  it('moves a deleted task worktree to the folder it was cut from', async () => {
    const root = folder(tempDir('turn-folder-'));
    const userData = folder(root, 'userData');
    const repo = folder(root, 'repo');
    const project = folder(root, 'project');
    const gone = join(userData, 'worktrees', 'task-1');

    await expect(
      movedFolderOf(gone, { source: repo, project, userDataDir: userData }),
    ).resolves.toBe(repo);
  });

  it('moves a deleted git worktree inside a repository to that repository', async () => {
    const root = folder(tempDir('turn-folder-'));
    const repo = folder(root, 'repo');
    folder(repo, '.git');
    const project = folder(root, 'project');
    const gone = join(repo, '.claude', 'worktrees', 'fix-1');

    await expect(
      movedFolderOf(gone, {
        source: null,
        project,
        userDataDir: folder(root, 'userData'),
      }),
    ).resolves.toBe(repo);
  });

  it('skips a source that is gone too, falling back to the project folder', async () => {
    const root = folder(tempDir('turn-folder-'));
    const userData = folder(root, 'userData');
    const project = folder(root, 'project');

    await expect(
      movedFolderOf(join(userData, 'worktrees', 'task-1'), {
        source: join(root, 'repo-deleted'),
        project,
        userDataDir: userData,
      }),
    ).resolves.toBe(project);
  });

  it('moves nowhere for a folder outside any card, repository or project — never to the folder above', async () => {
    const root = folder(tempDir('turn-folder-'));
    const parent = folder(root, 'scratch');

    await expect(
      movedFolderOf(join(parent, 'a', 'b'), {
        source: null,
        project: null,
        userDataDir: folder(root, 'userData'),
      }),
    ).resolves.toBeNull();
  });

  it("never moves a run into or above Geniro's data folder, nor into the home folder", async () => {
    const root = folder(tempDir('turn-folder-'));
    const userData = folder(root, 'userData');
    folder(userData, 'worktrees');

    await expect(
      movedFolderOf(join(userData, 'worktrees', 'task-1'), {
        source: folder(userData, 'artifacts'),
        project: root,
        userDataDir: userData,
      }),
    ).resolves.toBeNull();
    await expect(
      movedFolderOf(join(root, 'gone'), {
        source: homedir(),
        project: null,
        userDataDir: userData,
      }),
    ).resolves.toBeNull();
  });
});
