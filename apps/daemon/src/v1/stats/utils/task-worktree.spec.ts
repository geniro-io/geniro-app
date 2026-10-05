import { describe, expect, it } from 'vitest';

import { taskIdOfWorktree } from './task-worktree';

const WORKTREES = '/Users/me/Library/Application Support/Geniro/worktrees';

describe('taskIdOfWorktree', () => {
  it('names the task a worktree — or a folder inside one — may have been cut for', () => {
    expect(taskIdOfWorktree(`${WORKTREES}/ce106990`)).toBe('ce106990');
    expect(taskIdOfWorktree(`${WORKTREES}/ce106990/apps/ui`)).toBe('ce106990');
    // Whichever profile cut it: the dev app keeps another userData directory.
    expect(
      taskIdOfWorktree(
        '/Users/me/Library/Application Support/Geniro-dev/worktrees/ab12',
      ),
    ).toBe('ab12');
  });

  it('answers null for a path with no worktrees directory, or that ends at one', () => {
    expect(taskIdOfWorktree('/Users/me/Projects/app')).toBeNull();
    expect(taskIdOfWorktree(WORKTREES)).toBeNull();
    expect(taskIdOfWorktree('/Users/me/worktrees-old/ce106990')).toBeNull();
  });
});
