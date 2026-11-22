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
  cleanRepoAt,
  git,
  makeFixtureRepo,
  registerRowIn,
  removeFixtureRepo,
  TIMEOUT_MS,
} from './__tests__/worktree-service-repo';
import {
  prepareWorktree,
  pruneWorktreeForTask,
  readRegistry,
  settleFinishedWorktree,
  settleWorktreeForTask,
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

describe('settleFinishedWorktree', () => {
  it(
    'keeps the worktree when the daemon no longer calls the card finished, or cannot answer',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      await expect(
        settleFinishedWorktree('t1', async () => new Set<string>()),
      ).resolves.toEqual({ removed: false, committed: false });
      await expect(
        settleFinishedWorktree('t1', async () => null),
      ).resolves.toEqual({ removed: false, committed: false });
      await expect(
        settleFinishedWorktree('t1', async () => {
          throw new Error('daemon gone');
        }),
      ).resolves.toEqual({ removed: false, committed: false });

      expect(existsSync(made.path)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'removes it once the daemon says, right then, that the card is finished',
    async () => {
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      const asked: string[][] = [];

      await expect(
        settleFinishedWorktree('t1', async (ids) => {
          asked.push(ids);
          return new Set(ids);
        }),
      ).resolves.toEqual({ removed: true, committed: false });

      expect(asked).toEqual([['t1']]);
      expect(existsSync(made.path)).toBe(false);
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
