import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import {
  allFinished,
  cleanRepoAt,
  git,
  makeFixtureRepo,
  noneFinished,
  registerRowIn,
  removeFixtureRepo,
  TIMEOUT_MS,
} from './__tests__/worktree-service-repo';
import {
  prepareWorktree,
  readRegistry,
  reapFinishedWorktrees,
  removeWorktreeOnRequest,
  taskBranchName,
} from './worktree-service';

let repo: string;

const registerRow = (path: string): void =>
  registerRowIn(mocks.userData, repo, path);

beforeEach(() => {
  const fixture = makeFixtureRepo();
  mocks.userData = fixture.userData;
  repo = fixture.repo;
});

afterEach(() => {
  removeFixtureRepo({ userData: mocks.userData, repo });
});

describe('reapFinishedWorktrees', () => {
  it(
    'collects the worktree of a card whose work is finished',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([made.path]);
      expect(kept).toEqual([]);
      expect(existsSync(made.path)).toBe(false);
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'LEAVES the worktree of a card that is not finished, however clean it is',
    async () => {
      // The regression this pins: the reaper used to remove every clean
      // worktree at launch, which now means every reviewed conversation's cwd.
      // The worktree is clean on purpose — clean was the one thing that
      // condemned it before.
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      const { removed, kept } = await reapFinishedWorktrees(noneFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(made.path)).toBe(true);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'COMMITS a finished card’s unsaved work onto its branch before collecting it',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'half-done.txt'), 'not committed\n');

      const { removed } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([made.path]);
      expect(git(repo, 'show', 'geniro/task-t1:half-done.txt')).toBe(
        'not committed\n',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a finished card’s worktree when its work cannot be committed',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'half-done.txt'), 'the only copy\n');
      const hook = join(repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      chmodSync(hook, 0o755);

      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(join(made.path, 'half-done.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a finished card’s worktree left on a DETACHED HEAD',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'checkout', '-q', '--detach');
      writeFileSync(join(made.path, 'orphan.txt'), 'only on HEAD\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-q', '-m', 'reachable from HEAD alone');

      // With nobody watching: the reaper is the path the board never sees.
      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(join(made.path, 'orphan.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'collects NOTHING when the daemon cannot say which cards are finished',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      const unanswered = await reapFinishedWorktrees(() =>
        Promise.resolve(null),
      );
      // A question that THROWS is the same absence of an answer, not a reason
      // to fail the pass.
      const failed = await reapFinishedWorktrees(() =>
        Promise.reject(new Error('daemon unreachable')),
      );

      expect(unanswered).toEqual({ removed: [], kept: [made.path] });
      expect(failed).toEqual({ removed: [], kept: [made.path] });
      expect(existsSync(made.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'asks only about the worktrees still standing',
    async () => {
      await prepareWorktree({ taskId: 't1', folder: repo });
      const gone = await prepareWorktree({ taskId: 't2', folder: repo });
      rmSync(gone.path, { recursive: true, force: true });
      const isFinished = vi.fn(noneFinished);

      await reapFinishedWorktrees(isFinished);

      expect(isFinished).toHaveBeenCalledWith(['t1']);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves an entry it cannot confirm, rather than guessing',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // The project folder is gone, so git can answer nothing about the path.
      rmSync(repo, { recursive: true, force: true });

      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(made.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves a registered folder git does not list as a worktree, however clean',
    async () => {
      // A clean, standalone checkout in a task slot: its own repository, not a
      // worktree of the project. Only git's listing can tell the two apart.
      const slot = join(mocks.userData, 'worktrees', 't1');
      cleanRepoAt(slot, 'own.txt');
      // On the branch the row names, so the listing is the one guard left.
      git(slot, 'switch', '-q', '-c', 'b');
      registerRow(slot);

      const { removed } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(existsSync(join(slot, 'own.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'never touches a directory the registry does not name',
    async () => {
      const stranger = join(mocks.userData, 'worktrees', 'not-ours');
      mkdirSync(stranger, { recursive: true });
      writeFileSync(join(stranger, 'keep.txt'), 'mine\n');

      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([]);
      expect(existsSync(join(stranger, 'keep.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves an unregistered directory alone even with a real entry beside it',
    async () => {
      // The neighbouring empty-registry cases cannot reach the reap loop at all,
      // so this one seeds a genuine entry first: the loop runs, and the stranger
      // still has to survive it.
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      const stranger = join(mocks.userData, 'worktrees', 'not-ours');
      mkdirSync(stranger, { recursive: true });
      writeFileSync(join(stranger, 'keep.txt'), 'mine\n');

      const { removed } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([made.path]);
      expect(existsSync(join(stranger, 'keep.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'never deletes a registry path that sits OUTSIDE the worktrees directory',
    async () => {
      // The reaper reads the same untrusted file the prune path does, with
      // nobody watching. The fixture is a REAL worktree of this repository cut
      // somewhere else — the shape an older build with a different layout
      // would leave behind — and its card is reported finished, so the bound
      // is the only thing left standing between it and the delete.
      const outside = join(mocks.userData, 'outside-worktree');
      git(repo, 'worktree', 'add', '-b', 'stray', outside);
      registerRow(outside);

      const { removed, kept } = await reapFinishedWorktrees(allFinished);

      expect(removed).toEqual([]);
      expect(kept).toEqual([outside]);
      expect(existsSync(join(outside, 'README.md'))).toBe(true);
      // The row is dropped rather than retried on every pass — it names a path
      // this app will never act on.
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it('drops a row whose directory is already gone, deleting nothing', async () => {
    const made = await prepareWorktree({ taskId: 't1', folder: repo });
    rmSync(made.path, { recursive: true, force: true });
    const isFinished = vi.fn(noneFinished);

    const { removed } = await reapFinishedWorktrees(isFinished);

    expect(removed).toEqual([made.path]);
    expect(readRegistry()).toEqual([]);
    // Nothing is standing, so there is nothing to ask the daemon about.
    expect(isFinished).not.toHaveBeenCalled();
  });

  it('reads an unreadable registry as empty, so it can authorize no delete', async () => {
    writeFileSync(join(mocks.userData, 'worktrees.json'), 'not json at all');

    await expect(reapFinishedWorktrees(allFinished)).resolves.toEqual({
      removed: [],
      kept: [],
    });
    expect(readRegistry()).toEqual([]);
  });

  it('ignores registry rows that are not worktree records', () => {
    writeFileSync(
      join(mocks.userData, 'worktrees.json'),
      JSON.stringify([{ nonsense: true }, 'a string']),
    );

    expect(readRegistry()).toEqual([]);
  });

  it('keeps the registry file valid JSON after a write', async () => {
    await prepareWorktree({ taskId: 't1', folder: repo });

    const raw = readFileSync(join(mocks.userData, 'worktrees.json'), 'utf8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });
});

describe('removeWorktreeOnRequest', () => {
  const root = (): string => join(mocks.userData, 'worktrees');

  /** A worktree of `repo` in the worktrees directory that no registry row names. */
  const strayAt = (name: string, branch: string): string => {
    const path = join(root(), name);
    mkdirSync(root(), { recursive: true });
    git(repo, 'worktree', 'add', '-b', branch, path);
    return path;
  };

  it(
    "removes a finished card's clean worktree its agent moved to a branch of its own, keeping the branch",
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'switch', '-c', 'feat/renamed');
      writeFileSync(join(made.path, 'work.txt'), 'done\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-m', 'work');

      const outcome = await removeWorktreeOnRequest('t1', allFinished);

      expect(outcome).toEqual({ removed: true, reason: null });
      expect(existsSync(made.path)).toBe(false);
      expect(readRegistry()).toEqual([]);
      expect(git(repo, 'log', '-1', '--format=%s', 'feat/renamed').trim()).toBe(
        'work',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'keeps a worktree whose card is still open',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      const outcome = await removeWorktreeOnRequest('t1', noneFinished);

      expect(outcome.removed).toBe(false);
      expect(outcome.reason).toMatch(/card is still open/);
      expect(existsSync(made.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "commits a finished card's unsaved work on its own branch before removing it",
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'left.txt'), 'unsaved\n');

      const outcome = await removeWorktreeOnRequest('t1', allFinished);

      expect(outcome.removed).toBe(true);
      expect(
        git(
          repo,
          'show',
          '--name-only',
          '--format=',
          taskBranchName('t1'),
        ).trim(),
      ).toContain('left.txt');
    },
    TIMEOUT_MS,
  );

  it(
    'removes a clean worktree no registry row names through git, keeping its branch',
    async () => {
      const path = strayAt('stray', 'feat/stray');

      const outcome = await removeWorktreeOnRequest('stray', noneFinished);

      expect(outcome).toEqual({ removed: true, reason: null });
      expect(existsSync(path)).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(path);
      expect(git(repo, 'branch', '--list', 'feat/stray')).toContain(
        'feat/stray',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'keeps a worktree no registry row names while it holds unsaved changes',
    async () => {
      const path = strayAt('stray', 'feat/stray');
      writeFileSync(join(path, 'draft.txt'), 'unsaved\n');

      const outcome = await removeWorktreeOnRequest('stray', allFinished);

      expect(outcome.removed).toBe(false);
      expect(outcome.reason).toMatch(/unsaved changes/);
      expect(readFileSync(join(path, 'draft.txt'), 'utf8')).toBe('unsaved\n');
    },
    TIMEOUT_MS,
  );

  it(
    'keeps a worktree on a detached HEAD, whose commits could be lost',
    async () => {
      const path = strayAt('stray', 'feat/stray');
      git(path, 'switch', '--detach');

      const outcome = await removeWorktreeOnRequest('stray', allFinished);

      expect(outcome.removed).toBe(false);
      expect(outcome.reason).toMatch(/not on a branch/);
      expect(existsSync(path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'keeps a worktree when the app cannot ask whether its card is finished',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      for (const unanswered of [
        () => Promise.resolve(null),
        () => Promise.reject(new Error('daemon down')),
      ]) {
        const outcome = await removeWorktreeOnRequest('t1', unanswered);
        expect(outcome.removed).toBe(false);
        expect(existsSync(made.path)).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "keeps a finished card's worktree whose repository is not where it was",
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'draft.txt'), 'unsaved\n');
      rmSync(repo, { recursive: true, force: true });

      const outcome = await removeWorktreeOnRequest('t1', allFinished);

      expect(outcome.removed).toBe(false);
      expect(outcome.reason).toMatch(/repository is not where it was/);
      expect(readFileSync(join(made.path, 'draft.txt'), 'utf8')).toBe(
        'unsaved\n',
      );
    },
    TIMEOUT_MS,
  );

  it('deletes nothing in a folder git does not call a worktree', async () => {
    const path = join(root(), 'notes');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'keep.txt'), 'mine\n');

    const outcome = await removeWorktreeOnRequest('notes', allFinished);

    expect(outcome.removed).toBe(false);
    expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('mine\n');
  });
});
