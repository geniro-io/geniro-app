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
import { basename, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import {
  git,
  makeFixtureRepo,
  removeFixtureRepo,
  TIMEOUT_MS,
} from './__tests__/worktree-service-repo';
import { gitFailureLine } from './git-failure';
import { copyWorktreeIncludeFiles } from './worktree-include';
import {
  prepareWorktree,
  pruneWorktreeForTask,
  readRegistry,
  settleWorktreeForTask,
  taskBranchName,
  WORKTREES_DIR_NAME,
} from './worktree-service';

let repo: string;

beforeEach(() => {
  const fixture = makeFixtureRepo();
  mocks.userData = fixture.userData;
  repo = fixture.repo;
});

afterEach(() => {
  removeFixtureRepo({ userData: mocks.userData, repo });
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
    'does NOT hand back its slot because ANOTHER worktree holds the task branch',
    async () => {
      // The slot is on someone else's branch while the task's branch sits in a
      // different worktree: path and branch are both in git's listing, but in
      // two records — neither vouches for the slot.
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      git(made.path, 'switch', '-c', 'somebody-elses');
      git(
        repo,
        'worktree',
        'add',
        '-q',
        join(repo, '..', `${basename(repo)}-elsewhere`),
        'geniro/task-t1',
      );

      try {
        const again = await prepareWorktree({
          taskId: 't1',
          folder: repo,
        }).catch((error: unknown) => error);
        // Refused or rebuilt — never handed back as the task's own.
        expect(again).not.toMatchObject({ reused: true });
      } finally {
        rmSync(join(repo, '..', `${basename(repo)}-elsewhere`), {
          recursive: true,
          force: true,
        });
      }
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

  it(
    'takes its branch back from a worktree elsewhere whose directory is gone',
    async () => {
      // Another copy of the app (a dev build on its own userData) cut this
      // task's worktree somewhere else, and that directory was deleted without
      // `git worktree remove`: git still records the branch as checked out
      // there, and a plain `worktree add` refuses it.
      const elsewhere = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-elsewhere-')),
      );
      const stale = join(elsewhere, 't1');
      git(repo, 'worktree', 'add', '-b', 'geniro/task-t1', stale);
      rmSync(elsewhere, { recursive: true, force: true });

      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(made.reused).toBe(false);
      const listed = git(repo, 'worktree', 'list', '--porcelain');
      expect(listed).toContain(`worktree ${made.path}`);
      expect(listed).not.toContain(`worktree ${stale}`);
    },
    TIMEOUT_MS,
  );

  it(
    'leaves a LIVE checkout of its branch elsewhere alone, and says where it is',
    async () => {
      const elsewhere = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-elsewhere-')),
      );
      const live = join(elsewhere, 't1');
      git(repo, 'worktree', 'add', '-b', 'geniro/task-t1', live);
      writeFileSync(join(live, 'theirs.txt'), 'uncommitted\n');

      try {
        await expect(
          prepareWorktree({ taskId: 't1', folder: repo }),
        ).rejects.toThrow(/already used by worktree/);
        expect(existsSync(join(live, 'theirs.txt'))).toBe(true);
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
          `worktree ${live}`,
        );
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it('names the branch from the task id, never from anything a user typed', () => {
    expect(taskBranchName('a-b-c')).toBe('geniro/task-a-b-c');
  });
});

describe('.worktreeinclude files a new worktree starts with', () => {
  /** Ignore `ignoredName`, list `includeLines`, and write the ignored file. */
  const ignoreAndInclude = (
    ignoredName: string,
    includeLines: string[],
  ): void => {
    writeFileSync(join(repo, '.gitignore'), `${ignoredName}\n`);
    git(repo, 'add', '.gitignore');
    git(repo, 'commit', '-m', 'ignore');
    writeFileSync(
      join(repo, '.worktreeinclude'),
      `${includeLines.join('\n')}\n`,
    );
    const ignoredPath = join(repo, ignoredName);
    mkdirSync(dirname(ignoredPath), { recursive: true });
    writeFileSync(ignoredPath, 'ignored-by-git\n');
  };

  it(
    'copies a gitignored file listed in .worktreeinclude into a NEW worktree',
    async () => {
      ignoreAndInclude('.env', ['.env']);
      const log = vi.fn();

      const made = await prepareWorktree(
        { taskId: 't1', folder: repo },
        { log },
      );

      expect(made.reused).toBe(false);
      expect(readFileSync(join(made.path, '.env'), 'utf8')).toBe(
        'ignored-by-git\n',
      );
      expect(log).toHaveBeenCalledWith(
        'info',
        expect.stringContaining('worktree include copied 1 file(s)'),
      );
      expect(log).toHaveBeenCalledWith('info', expect.stringContaining('.env'));
    },
    TIMEOUT_MS,
  );

  it(
    'leaves a tracked file that matches .worktreeinclude to git',
    async () => {
      writeFileSync(join(repo, 'tracked.cfg'), 'from-git\n');
      git(repo, 'add', 'tracked.cfg');
      git(repo, 'commit', '-m', 'tracked');
      writeFileSync(join(repo, 'tracked.cfg'), 'edited-in-source\n');
      writeFileSync(join(repo, '.gitignore'), 'local-only\n');
      git(repo, 'add', '.gitignore');
      git(repo, 'commit', '-m', 'ignore');
      writeFileSync(join(repo, 'local-only'), 'local\n');
      writeFileSync(
        join(repo, '.worktreeinclude'),
        'tracked.cfg\nlocal-only\n',
      );

      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(readFileSync(join(made.path, 'tracked.cfg'), 'utf8')).toBe(
        'from-git\n',
      );
      expect(existsSync(join(made.path, 'local-only'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'does not copy a listed file that is NOT gitignored',
    async () => {
      writeFileSync(join(repo, '.gitignore'), 'secret.env\n');
      git(repo, 'add', '.gitignore');
      git(repo, 'commit', '-m', 'ignore');
      writeFileSync(join(repo, 'plain.txt'), 'visible\n');
      writeFileSync(join(repo, '.worktreeinclude'), 'plain.txt\n');

      const made = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(existsSync(join(made.path, 'plain.txt'))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'copies nothing when the checkout has no .worktreeinclude',
    async () => {
      writeFileSync(join(repo, '.gitignore'), '.env\n');
      git(repo, 'add', '.gitignore');
      git(repo, 'commit', '-m', 'ignore');
      writeFileSync(join(repo, '.env'), 'secret\n');
      const log = vi.fn();

      const made = await prepareWorktree(
        { taskId: 't1', folder: repo },
        { log },
      );

      expect(existsSync(join(made.path, '.env'))).toBe(false);
      expect(log).not.toHaveBeenCalled();
    },
    TIMEOUT_MS,
  );

  it(
    'does not copy through a symlink that points outside the repository',
    async () => {
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-outside-')),
      );
      writeFileSync(join(outside, 'leak.txt'), 'outside\n');
      try {
        ignoreAndInclude('link-target', ['link-target']);
        rmSync(join(repo, 'link-target'));
        symlinkSync(join(outside, 'leak.txt'), join(repo, 'link-target'));

        const made = await prepareWorktree({ taskId: 't1', folder: repo });

        expect(existsSync(join(made.path, 'link-target'))).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'never writes through a symlinked folder the task branch carries',
    async () => {
      // A leftover task branch, from an earlier run, that committed `config`
      // as a symlink out of the tree; in the checkout `config/` is a real,
      // ignored folder holding the listed `.env`.
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-outside-')),
      );
      try {
        writeFileSync(join(repo, '.gitignore'), 'config/\n');
        git(repo, 'add', '.gitignore');
        git(repo, 'commit', '-m', 'ignore');
        git(repo, 'checkout', '-b', taskBranchName('t1'));
        symlinkSync(outside, join(repo, 'config'));
        git(repo, 'add', '-f', 'config');
        git(repo, 'commit', '-m', 'a symlinked folder');
        git(repo, 'checkout', 'main');
        mkdirSync(join(repo, 'config'));
        writeFileSync(join(repo, 'config', '.env'), 'secret\n');
        writeFileSync(join(repo, '.worktreeinclude'), 'config/.env\n');
        const log = vi.fn();

        const made = await prepareWorktree(
          { taskId: 't1', folder: repo },
          { log },
        );

        expect(existsSync(join(outside, '.env'))).toBe(false);
        expect(log).toHaveBeenCalledWith(
          'warn',
          expect.stringContaining('skipped config/.env: a folder on its path'),
        );
        expect(made.reused).toBe(false);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );

  it(
    'logs and copies nothing when the worktree folder cannot be resolved',
    async () => {
      ignoreAndInclude('.env', ['.env']);
      const log = vi.fn();

      await copyWorktreeIncludeFiles({
        folder: repo,
        worktree: join(mocks.userData, 'no-such-worktree'),
        log,
      });

      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('worktree include not copied into'),
      );
      expect(existsSync(join(mocks.userData, 'no-such-worktree'))).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'does not overwrite a file that is already present in the worktree',
    async () => {
      ignoreAndInclude('keep.cfg', ['keep.cfg']);
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      writeFileSync(join(made.path, 'keep.cfg'), 'already-here\n');
      writeFileSync(join(repo, 'keep.cfg'), 'from-source\n');

      await copyWorktreeIncludeFiles({
        folder: repo,
        worktree: made.path,
        log: () => {},
      });

      expect(readFileSync(join(made.path, 'keep.cfg'), 'utf8')).toBe(
        'already-here\n',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'logs a file it could not copy and copies the rest',
    async () => {
      ignoreAndInclude('conf/local.json', ['conf/local.json', '.env']);
      writeFileSync(join(repo, '.gitignore'), 'conf/local.json\n.env\n');
      git(repo, 'commit', '-am', 'ignore both');
      writeFileSync(join(repo, '.env'), 'env\n');
      const made = await prepareWorktree({ taskId: 't1', folder: repo });
      rmSync(join(made.path, '.env'));
      rmSync(join(made.path, 'conf'), { recursive: true, force: true });
      // A FILE where the copy needs a folder.
      writeFileSync(join(made.path, 'conf'), 'in the way\n');
      const log = vi.fn();

      await copyWorktreeIncludeFiles({
        folder: repo,
        worktree: made.path,
        log,
      });

      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('could not copy conf/local.json'),
      );
      expect(readFileSync(join(made.path, '.env'), 'utf8')).toBe('env\n');
    },
    TIMEOUT_MS,
  );

  it(
    'copies from the repository root when the card folder is a subfolder',
    async () => {
      const pkg = join(repo, 'packages', 'app');
      mkdirSync(pkg, { recursive: true });
      ignoreAndInclude('.env', ['.env']);

      const made = await prepareWorktree({ taskId: 't1', folder: pkg });

      expect(readFileSync(join(made.path, '.env'), 'utf8')).toBe(
        'ignored-by-git\n',
      );
    },
    TIMEOUT_MS,
  );

  it(
    'copies nothing into a REUSED worktree',
    async () => {
      ignoreAndInclude('.claude/settings.local.json', [
        '.claude/settings.local.json',
      ]);
      const first = await prepareWorktree({ taskId: 't1', folder: repo });
      rmSync(join(first.path, '.claude'), { recursive: true, force: true });

      const again = await prepareWorktree({ taskId: 't1', folder: repo });

      expect(again.reused).toBe(true);
      expect(
        existsSync(join(again.path, '.claude', 'settings.local.json')),
      ).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'logs and still makes the worktree when git cannot read .worktreeinclude',
    async () => {
      // A directory where the file should be: it exists, and git refuses it
      // as an exclude file.
      mkdirSync(join(repo, '.worktreeinclude'));
      const log = vi.fn();

      const made = await prepareWorktree(
        { taskId: 't1', folder: repo },
        { log },
      );

      expect(made.reused).toBe(false);
      expect(existsSync(join(made.path, 'README.md'))).toBe(true);
      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('git could not list the ignored files'),
      );
    },
    TIMEOUT_MS,
  );

  it(
    'logs and goes on when git cannot name the checkout',
    async () => {
      const notARepo = realpathSync(
        mkdtempSync(join(tmpdir(), 'geniro-worktree-plain-')),
      );
      const log = vi.fn();
      try {
        await expect(
          copyWorktreeIncludeFiles({
            folder: notARepo,
            worktree: join(notARepo, 'wt'),
            log,
          }),
        ).resolves.toBeUndefined();
      } finally {
        rmSync(notARepo, { recursive: true, force: true });
      }

      expect(log).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('could not name the checkout root'),
      );
    },
    TIMEOUT_MS,
  );
});

describe('prepareWorktree by what the folder is', () => {
  let plain: string;

  beforeEach(() => {
    plain = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-worktree-plain-')));
  });

  afterEach(() => {
    rmSync(plain, { recursive: true, force: true });
  });

  it('hands back a folder in no repository as the place to work, with no branch, and records nothing', async () => {
    mkdirSync(join(plain, 'back-office'));
    writeFileSync(join(plain, 'notes.md'), 'mine\n');

    const made = await prepareWorktree({ taskId: 't1', folder: plain });

    expect(made).toEqual({ path: plain, branch: null, reused: false });
    expect(readRegistry()).toEqual([]);
    expect(existsSync(join(mocks.userData, 'worktrees', 't1'))).toBe(false);
    expect(await pruneWorktreeForTask('t1')).toBe(false);
    expect(await settleWorktreeForTask('t1')).toEqual({
      removed: false,
      committed: false,
    });
    expect(readFileSync(join(plain, 'notes.md'), 'utf8')).toBe('mine\n');
  });

  it('says a folder that does not exist does not exist, and the fix', async () => {
    const gone = join(plain, 'moved-away');

    const refusal = await prepareWorktree({ taskId: 't1', folder: gone }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toBe(
      `the folder ${gone} does not exist — set this task's folder to the folder it works in (its project's folder is used only when the task names none)`,
    );
    expect(gitFailureLine(refusal, message)).toBe(message);
    expect(readRegistry()).toEqual([]);
  });

  it(
    'still cuts the worktree through a symlink into a repository subfolder',
    async () => {
      mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
      const link = join(plain, 'app');
      symlinkSync(join(repo, 'packages', 'app'), link);

      const made = await prepareWorktree({ taskId: 't1', folder: link });

      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${made.path}`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'still cuts the worktree from a bare repository',
    async () => {
      const bare = join(plain, 'bare.git');
      git(plain, 'clone', '--bare', repo, bare);

      const made = await prepareWorktree({ taskId: 't1', folder: bare });

      expect(git(bare, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${made.path}`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'still cuts the worktree from a linked worktree, whose .git is a file',
    async () => {
      const linked = join(plain, 'linked');
      git(repo, 'worktree', 'add', '-b', 'side', linked);

      const made = await prepareWorktree({ taskId: 't1', folder: linked });

      expect(made.reused).toBe(false);
      expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(
        `worktree ${made.path}`,
      );
    },
    TIMEOUT_MS,
  );
});

describe("where the daemon looks for a card's worktree", () => {
  it("is the folder main makes it in: the twin of the daemon's TASK_WORKTREES_DIR_NAME", () => {
    const daemon = readFileSync(
      join(__dirname, '../../../daemon/src/v1/tasks/utils/task-worktree.ts'),
      'utf8',
    );

    expect(daemon).toContain(
      `export const TASK_WORKTREES_DIR_NAME = '${WORKTREES_DIR_NAME}';`,
    );
  });
});
