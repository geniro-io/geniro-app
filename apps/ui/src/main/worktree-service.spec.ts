import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
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
  reapFinishedWorktrees,
  settleWorktreeForTask,
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

/** The daemon's answer for a reaper pass: every card named is finished. */
const allFinished = (taskIds: string[]): Promise<ReadonlySet<string>> =>
  Promise.resolve(new Set(taskIds));

/** The daemon's answer for a reaper pass: no card named is finished. */
const noneFinished = (): Promise<ReadonlySet<string>> =>
  Promise.resolve(new Set<string>());

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
      expect(made.reused).toBe(false);
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
    'hands back the task’s OWN worktree, still standing, rather than cutting a new one',
    async () => {
      const first = await prepareWorktree({ taskId: 't1', folder: repo });
      git(first.path, 'config', 'user.email', 'spec@example.com');
      writeFileSync(join(first.path, 'committed.txt'), 'kept\n');
      git(first.path, 'add', '.');
      git(first.path, 'commit', '-m', 'the first run’s work');
      const head = git(first.path, 'rev-parse', 'HEAD').trim();

      // A worktree lives until its card is Done, so a second press — Stop sent
      // the card back, or its run failed, or it is pressed again from review —
      // routinely finds the first run's worktree here.
      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again).toEqual({
        path: first.path,
        branch: 'geniro/task-t1',
        reused: true,
      });
      // The SAME checkout, not a fresh one cut in its place.
      expect(git(again.path, 'rev-parse', 'HEAD').trim()).toBe(head);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'CONTINUES in its own worktree with the uncommitted work still in it',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'in-progress.txt'), 'not committed\n');

      // That work is this task's, and the run being started is its next step.
      // Refusing here turned every re-run of a card whose agent had not
      // committed into "commit or clear them" before it could go on.
      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.reused).toBe(true);
      expect(existsSync(join(made.path, 'in-progress.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'does NOT hand back a checkout in its slot that is on another branch',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // Still a worktree of this repository, at this very path — but no longer
      // this task's branch, so continuing in it would run the task on work
      // that is not its own.
      git(made.path, 'switch', '-c', 'somebody-elses');

      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.reused).toBe(false);
      expect(git(again.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(
        'geniro/task-t1',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'REFUSES to clear its own worktree left on a DETACHED HEAD, however clean',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'checkout', '-q', '--detach');
      writeFileSync(join(made.path, 'orphan.txt'), 'only on HEAD\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-q', '-m', 'reachable from HEAD alone');
      const orphan = git(made.path, 'rev-parse', 'HEAD').trim();

      // Not "this task's branch", so not handed back — and clearing it to cut
      // a fresh one would delete the one commit HEAD alone holds.
      await expect(
        prepareWorktree({ taskId: 't1', folder: repo }),
      ).rejects.toThrow(/detached HEAD/);
      expect(git(made.path, 'rev-parse', 'HEAD').trim()).toBe(orphan);
    },
    TIMEOUT_MS,
  );

  it(
    'clears an EMPTY directory in its slot and cuts the worktree there',
    async () => {
      // What a user makes by hand to get a chat whose cwd vanished to answer
      // again — nothing in it to lose, and git has nothing to say about it.
      mkdirSync(join(mocks.userData, 'worktrees', 't1'), { recursive: true });

      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(made.reused).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${made.path}`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'REFUSES a directory in its slot holding things git cannot account for',
    async () => {
      const slot = join(mocks.userData, 'worktrees', 't1');
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, 'notes.txt'), 'somebody’s\n');

      // Not this task's worktree, and not empty: nothing here can say whether
      // it is the only copy of something.
      await expect(
        prepareWorktree({ taskId: 't1', folder: repo }),
      ).rejects.toThrow(/git cannot say what is in it/);
      expect(existsSync(join(slot, 'notes.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'RE-USES a branch left behind by an earlier run',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // Removing a worktree deliberately keeps its branch, so this is the state
      // after any failed start and after every collection. `-b` refuses a
      // branch that exists, so without the re-use the card could never run
      // again.
      await pruneWorktreeForTask('t1');
      expect(git(repo, 'branch', '--list', 'geniro/task-t1')).toContain(
        'geniro/task-t1',
      );

      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.branch).toBe('geniro/task-t1');
      expect(again.path).toBe(made.path);
      expect(again.reused).toBe(false);
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
    'KEEPS a clean worktree on a DETACHED HEAD, whose commits nothing else reaches',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'checkout', '-q', '--detach');
      writeFileSync(join(made.path, 'orphan.txt'), 'only on HEAD\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-q', '-m', 'reachable from HEAD alone');

      await expect(pruneWorktreeForTask('t1')).resolves.toBe(false);

      expect(existsSync(join(made.path, 'orphan.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );

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

describe('settleWorktreeForTask', () => {
  it(
    'COMMITS what the agent left, then removes the worktree',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'work.txt'), 'the agent wrote this\n');

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: true,
        committed: true,
      });

      // The whole justification for removing a dirty worktree: the work is on
      // the branch, which is never removed with it.
      expect(git(repo, 'show', 'geniro/task-t1:work.txt')).toBe(
        'the agent wrote this\n',
      );
      expect(existsSync(made.path)).toBe(false);
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    'removes a CLEAN worktree without putting an empty commit on the branch',
    async () => {
      await prepareWorktree({ taskId: 't1', folder: repo });
      const before = git(repo, 'rev-parse', 'geniro/task-t1').trim();

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: true,
        committed: false,
      });

      // A rescue commit on every finished task would say nothing happened, on
      // every branch where nothing did.
      expect(git(repo, 'rev-parse', 'geniro/task-t1').trim()).toBe(before);
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS the worktree when the repository refuses the commit',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'work.txt'), 'the only copy\n');
      // A worktree shares its repository's hooks, and this app runs them
      // rather than passing `--no-verify`. A repository whose hooks reject an
      // agent's half-finished tree must therefore keep the directory: it is
      // the only place that work still exists.
      const hook = join(repo, '.git', 'hooks', 'pre-commit');
      writeFileSync(hook, '#!/bin/sh\nexit 1\n');
      chmodSync(hook, 0o755);

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: false,
        committed: false,
      });

      expect(existsSync(join(made.path, 'work.txt'))).toBe(true);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'never deletes a registry path that sits OUTSIDE the worktrees directory',
    async () => {
      // The sibling bound, on the path that is allowed to clear a DIRTY tree —
      // so it is the one where an unbounded row would cost the most.
      const outside = join(mocks.userData, 'not-a-worktree');
      cleanRepoAt(outside, 'precious.txt');
      writeFileSync(join(outside, 'uncommitted.txt'), 'do not touch\n');
      registerRow(outside);

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: false,
        committed: false,
      });

      expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
      expect(existsSync(join(outside, 'uncommitted.txt'))).toBe(true);
      expect(readRegistry()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it('answers removed:false for a task this app never made a worktree for', async () => {
    await expect(settleWorktreeForTask('never')).resolves.toEqual({
      removed: false,
      committed: false,
    });
  });

  it(
    'KEEPS a worktree on a DETACHED HEAD, whose commits nothing else reaches',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      // What an agent that rebased, bisected or just checked out a commit
      // leaves: a clean tree, and a commit reachable from HEAD alone.
      git(made.path, 'checkout', '-q', '--detach');
      writeFileSync(join(made.path, 'orphan.txt'), 'only on HEAD\n');
      git(made.path, 'add', '.');
      git(made.path, 'commit', '-q', '-m', 'reachable from HEAD alone');
      const orphan = git(made.path, 'rev-parse', 'HEAD').trim();

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: false,
        committed: false,
      });

      expect(existsSync(made.path)).toBe(true);
      expect(git(made.path, 'rev-parse', 'HEAD').trim()).toBe(orphan);
      expect(readRegistry()).toHaveLength(1);
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a worktree with a merge stopped half way, rather than committing its conflict',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'README.md'), '# the task’s version\n');
      git(made.path, 'commit', '-q', '-am', 'task edit');
      writeFileSync(join(repo, 'README.md'), '# main’s version\n');
      git(repo, 'commit', '-q', '-am', 'main edit');
      const before = git(repo, 'rev-parse', 'geniro/task-t1').trim();
      // HEAD is still the task's branch here — only the marker says a merge is
      // open, and `add -A` + `commit` would conclude it with the markers in.
      try {
        git(made.path, 'merge', 'main');
      } catch {
        // The conflict is the point: git exits non-zero and leaves MERGE_HEAD.
      }

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: false,
        committed: false,
      });

      expect(git(repo, 'rev-parse', 'geniro/task-t1').trim()).toBe(before);
      expect(readFileSync(join(made.path, 'README.md'), 'utf8')).toContain(
        '<<<<<<<',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a worktree switched to ANOTHER branch, rather than committing onto it',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'switch', '-q', '-c', 'somebody-elses');
      writeFileSync(join(made.path, 'work.txt'), 'uncommitted\n');

      await expect(settleWorktreeForTask('t1')).resolves.toEqual({
        removed: false,
        committed: false,
      });

      // The rescue commit is promised onto the TASK's branch; this one would
      // have landed on a branch nobody asked it to touch.
      expect(
        git(repo, 'log', '-1', '--format=%s', 'somebody-elses').trim(),
      ).toBe('first');
      expect(existsSync(join(made.path, 'work.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('the dirty check runs none of the repository’s own programs', () => {
  it(
    'settles a touched worktree without running the repository’s clean filter',
    async () => {
      // The reaper and the board run this with nobody pressing anything, so it
      // is a READ in `git-safe-config.ts`'s sense — and a `status` re-hashing a
      // touched file runs whatever clean filter `.gitattributes` names.
      const scratch = mkdtempSync(join(tmpdir(), 'geniro-worktree-filter-'));
      try {
        const marker = join(scratch, 'filter-ran');
        const program = join(scratch, 'evil.sh');
        writeFileSync(
          program,
          `#!/bin/sh\n: > ${JSON.stringify(marker)}\ncat\n`,
          { mode: 0o755 },
        );
        writeFileSync(join(repo, '.gitattributes'), 'f.txt filter=evil\n');
        writeFileSync(join(repo, 'f.txt'), 'content\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-q', '-m', 'filtered file');
        const made = await prepareWorktree({ taskId: 't1', folder: repo });
        // Armed AFTER the checkout, so the worktree's files are the raw bytes.
        git(repo, 'config', 'filter.evil.clean', program);
        const moved = new Date(Date.UTC(2001, 0, 1));
        utimesSync(join(made.path, 'f.txt'), moved, moved);
        // The control: plain git really does run it here. Its `status` records
        // the moved stat data in the index, so the file is moved again after.
        git(made.path, 'status', '--porcelain');
        expect(existsSync(marker)).toBe(true);
        rmSync(marker);
        const again = new Date(Date.UTC(2001, 0, 2));
        utimesSync(join(made.path, 'f.txt'), again, again);

        await expect(settleWorktreeForTask('t1')).resolves.toEqual({
          removed: true,
          committed: false,
        });

        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'KEEPS a worktree holding a checked-out submodule, which its removal would delete',
    async () => {
      // `status` no longer looks inside a submodule (that look runs the
      // submodule's own config), and the submodule's repository — commits
      // included — lives under this worktree's own git directory.
      const source = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-sub-')),
      );
      try {
        cleanRepoAt(source, 's.txt');
        git(
          repo,
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-q',
          source,
          'sub',
        );
        git(repo, 'commit', '-q', '-m', 'add the submodule');
        const made = await prepareWorktree({ taskId: 't1', folder: repo });
        git(
          made.path,
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'update',
          '-q',
          '--init',
        );

        await expect(pruneWorktreeForTask('t1')).resolves.toBe(false);

        expect(existsSync(join(made.path, 'sub', 's.txt'))).toBe(true);
      } finally {
        rmSync(source, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'still collects a worktree of a repository whose submodule was never checked out there',
    async () => {
      // The other direction: merely HAVING a submodule must not make every
      // worktree of the repository uncollectable. `worktree add` leaves it
      // uninitialised — an empty directory and no git directory.
      const source = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-sub-')),
      );
      try {
        cleanRepoAt(source, 's.txt');
        git(
          repo,
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-q',
          source,
          'sub',
        );
        git(repo, 'commit', '-q', '-m', 'add the submodule');
        const made = await prepareWorktree({ taskId: 't1', folder: repo });

        await expect(pruneWorktreeForTask('t1')).resolves.toBe(true);

        expect(existsSync(made.path)).toBe(false);
      } finally {
        rmSync(source, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
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
