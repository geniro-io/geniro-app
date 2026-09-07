import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import {
  prepareWorktree,
  pruneWorktreeForTask,
  readRegistry,
  reapOrphanedWorktrees,
  taskBranchName,
} from './worktree-service';

/**
 * Driven against a REAL repository, on `git-info.spec.ts`'s reasoning: the
 * behaviour under test is git's own — which worktree operations succeed, what
 * `worktree list --porcelain` reports, when a remove is refused — and a mocked
 * `execFile` would only replay this file's assumptions about it.
 */

/** Every case here drives several real git subprocesses against a temp repo. */
const TIMEOUT_MS = 30_000;

let repo: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A clean git checkout at `path`, holding one committed file.
 *
 * The containment cases below need a directory `git status` can ANSWER for:
 * against a non-repo directory `isDirty` reports "unconfirmable", which every
 * caller reads as "leave it alone" — so the delete is refused by that guard
 * and the containment check the case is named for is never reached.
 */
const cleanRepoAt = (path: string, file: string): void => {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.email', 'spec@example.com');
  git(path, 'config', 'user.name', 'Spec');
  writeFileSync(join(path, file), 'do not delete\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'committed');
};

const registerRow = (path: string): void => {
  writeFileSync(
    join(mocks.userData, 'worktrees.json'),
    JSON.stringify([
      { taskId: 't1', path, branch: 'b', folder: repo, createdAt: '' },
    ]),
  );
};

beforeEach(() => {
  mocks.userData = realpathSync(
    mkdtempSync(join(tmpdir(), 'geniro-worktree-ud-')),
  );
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-worktree-repo-')));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'spec@example.com');
  git(repo, 'config', 'user.name', 'Spec');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('prepareWorktree', () => {
  it(
    'creates a real worktree on its own branch and records it',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(made.branch).toBe('geniro/task-t1');
      expect(existsSync(made.path)).toBe(true);
      // git's own view, not ours: the path is a worktree of THIS repository.
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${made.path}`,
      );
      expect(readRegistry()).toEqual([
        expect.objectContaining({
          taskId: 't1',
          path: made.path,
          branch: 'geniro/task-t1',
          folder: repo,
        }),
      ]);
    },
    TIMEOUT_MS,
  );

  it(
    're-runs over a CLEAN leftover the previous session left behind',
    async () => {
      const first = await prepareWorktree({ taskId: 't1', folder: repo });
      // The app died here: the worktree and its registry row survive, and the
      // reaper has not run. A second press must still get a worktree, which it
      // does by clearing the leftover — it holds nothing — and cutting a new
      // one in its place.
      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.path).toBe(first.path);
      expect(existsSync(again.path)).toBe(true);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'REFUSES a re-run over a worktree holding uncommitted work',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'in-progress.txt'), 'not committed\n');

      // Same rule the reaper states, and it has to hold here too: from this side
      // of the boundary a checkout an agent is working in right now looks exactly
      // like a leftover, since the claim that knows otherwise is in the daemon
      // and is consulted after.
      await expect(
        prepareWorktree({ taskId: 't1', folder: repo }),
      ).rejects.toThrow(/uncommitted changes/);
      expect(existsSync(join(made.path, 'in-progress.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'RE-USES a branch left behind by an earlier run',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // Removing a worktree deliberately keeps its branch, so this is the state
      // after any failed start and after every boot reap. `-b` refuses a branch
      // that exists, so without the re-use the card could never run again.
      await pruneWorktreeForTask('t1');
      expect(git(repo, 'branch', '--list', 'geniro/task-t1')).toContain(
        'geniro/task-t1',
      );

      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.branch).toBe('geniro/task-t1');
      expect(again.path).toBe(made.path);
      expect(existsSync(again.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it('names the branch from the task id, never from anything a user typed', () => {
    expect(taskBranchName('a-b-c')).toBe('geniro/task-a-b-c');
  });
});

describe('pruneWorktreeForTask', () => {
  it(
    'removes the worktree it made, and says so',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      await expect(pruneWorktreeForTask('t1')).resolves.toBe(true);

      expect(existsSync(made.path)).toBe(false);
      expect(readRegistry()).toEqual([]);
      expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(
        made.path,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'keeps the BRANCH, which is where the agent’s work is',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'work.txt'), 'done\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-m', 'the agent’s work');

      await pruneWorktreeForTask('t1');

      // Removing the workspace must never destroy the commits made in it.
      expect(git(repo, 'branch', '--list', 'geniro/task-t1')).toContain(
        'geniro/task-t1',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a worktree holding uncommitted work',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'unsaved.txt'), 'the only copy\n');

      // An agent that finished without committing has left the only copy of
      // its work in here.
      await expect(pruneWorktreeForTask('t1')).resolves.toBe(false);
      expect(existsSync(join(made.path, 'unsaved.txt'))).toBe(true);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it('answers false for a task this app never made a worktree for', async () => {
    await expect(pruneWorktreeForTask('never')).resolves.toBe(false);
  });

  it(
    'never deletes a registry path that sits OUTSIDE the worktrees directory',
    async () => {
      // The registry is a plain JSON file in the userData dir, and it is the ONLY
      // thing that authorizes a delete. `readRegistry` checks that its fields are
      // strings and nothing more, so a row whose `path` names somewhere else —
      // corrupted, hand-edited, or written by an older build with a different
      // layout — would point `rmSync(recursive, force)` at that path instead.
      //
      // It is a CLEAN CHECKOUT deliberately: git can answer for it, so the
      // dirty guard passes and containment is the only thing left standing.
      // The property is what is pinned rather than one guard's site — it is
      // checked at the lookup AND again at the delete — so this goes red when
      // the bound is gone, not when it moves.
      const outside = join(mocks.userData, 'not-a-worktree');
      cleanRepoAt(outside, 'precious.txt');
      registerRow(outside);

      await expect(pruneWorktreeForTask('t1')).resolves.toBe(false);

      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
      // The row is dropped rather than retried forever — it names a path this
      // app will never act on.
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'never follows a SYMLINK out of the worktrees directory',
    async () => {
      // A lexical prefix test is satisfied by this row: the string does begin
      // with the worktrees root. `resolve()` does not follow links, so only the
      // one-segment rule — a real worktree is `<root>/<taskId>` and nothing
      // deeper — keeps the delete off the link's target.
      const target = join(mocks.userData, 'elsewhere');
      cleanRepoAt(join(target, 'inner'), 'precious.txt');
      const root = join(mocks.userData, 'worktrees');
      mkdirSync(root, { recursive: true });
      symlinkSync(target, join(root, 'link'));
      registerRow(join(root, 'link', 'inner'));

      await expect(pruneWorktreeForTask('t1')).resolves.toBe(false);

      expect(existsSync(join(target, 'inner', 'precious.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('reapOrphanedWorktrees', () => {
  it(
    'clears a clean worktree a previous launch left behind',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      const { removed, kept } = await reapOrphanedWorktrees();

      expect(removed).toEqual([made.path]);
      expect(kept).toEqual([]);
      expect(existsSync(made.path)).toBe(false);
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'LEAVES a worktree holding uncommitted work',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'half-done.txt'), 'not committed\n');

      const { removed, kept } = await reapOrphanedWorktrees();

      // A stray costs disk; a mistaken removal costs the user their agent's
      // unsaved work. The registry row stays too, so a later launch can try.
      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(join(made.path, 'half-done.txt'))).toBe(true);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves an entry it cannot confirm, rather than guessing',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // The project folder is gone, so git can answer nothing about the path.
      rmSync(repo, { recursive: true, force: true });

      const { removed, kept } = await reapOrphanedWorktrees();

      expect(removed).toEqual([]);
      expect(kept).toEqual([made.path]);
      expect(existsSync(made.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'never touches a directory the registry does not name',
    async () => {
      const stranger = join(mocks.userData, 'worktrees', 'not-ours');
      mkdirSync(stranger, { recursive: true });
      writeFileSync(join(stranger, 'keep.txt'), 'mine\n');

      const { removed, kept } = await reapOrphanedWorktrees();

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

      const { removed } = await reapOrphanedWorktrees();

      expect(removed).toEqual([made.path]);
      expect(existsSync(join(stranger, 'keep.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'never deletes a registry path that sits OUTSIDE the worktrees directory',
    async () => {
      // The reaper reads the same untrusted file the prune path does, and it
      // runs at boot with nobody watching. The fixture is a REAL worktree of
      // this repository cut somewhere else — the shape an older build with a
      // different layout would leave behind — because that is the only one the
      // reaper would otherwise act on: an unregistered path is already kept by
      // the `registered` arm, so a stranger directory here would pass with the
      // bound deleted and pin nothing.
      const outside = join(mocks.userData, 'outside-worktree');
      git(repo, 'worktree', 'add', '-b', 'stray', outside);
      registerRow(outside);

      const { removed, kept } = await reapOrphanedWorktrees();

      expect(removed).toEqual([]);
      expect(kept).toEqual([outside]);
      expect(existsSync(join(outside, 'README.md'))).toBe(true);
      // The row is dropped rather than retried at every launch — it names a
      // path this app will never act on.
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it('drops a row whose directory is already gone, deleting nothing', async () => {
    const made = await prepareWorktree({ taskId: 't1', folder: repo });
    rmSync(made.path, { recursive: true, force: true });

    const { removed } = await reapOrphanedWorktrees();

    expect(removed).toEqual([made.path]);
    expect(readRegistry()).toEqual([]);
  });

  it('reads an unreadable registry as empty, so it can authorize no delete', async () => {
    writeFileSync(join(mocks.userData, 'worktrees.json'), 'not json at all');

    await expect(reapOrphanedWorktrees()).resolves.toEqual({
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
