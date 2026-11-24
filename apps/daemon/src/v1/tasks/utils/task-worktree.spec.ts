import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { environment } from '../../../environments';
import {
  TASK_WORKTREES_DIR_NAME,
  taskRunFolder,
  taskWorktreesRoot,
} from './task-worktree';

describe('taskRunFolder', () => {
  const root = '/data/worktrees';

  it("runs a start that names a branch in the card's worktree, whatever the card's folder", () => {
    expect(
      taskRunFolder(
        { id: 't1', folder: '/elsewhere' },
        '/repo',
        'geniro/task-t1',
        root,
      ),
    ).toBe(join(root, 't1'));
  });

  it("runs a start with no branch in the card's own folder", () => {
    expect(
      taskRunFolder(
        { id: 't1', folder: '/elsewhere' },
        '/repo',
        undefined,
        root,
      ),
    ).toBe('/elsewhere');
  });

  it("runs a start with no branch for a card naming no folder in its project's", () => {
    expect(
      taskRunFolder({ id: 't1', folder: null }, '/repo', undefined, root),
    ).toBe('/repo');
  });
});

describe('taskWorktreesRoot', () => {
  it('is the worktrees folder under the userData folder Electron main makes worktrees in', () => {
    expect(taskWorktreesRoot()).toBe(
      join(environment.userDataDir, TASK_WORKTREES_DIR_NAME),
    );
  });
});
