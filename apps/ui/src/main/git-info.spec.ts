import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pullBranch,
  pullStashIsOurs,
  readGitInfo,
  readOriginOwner,
  switchBranch,
} from './git-info';

/**
 * Driven against REAL repositories, not a mocked `execFile`. The behaviour
 * under test is git's own — which argument forms resolve a branch, when a
 * checkout is refused — and a mock would only replay this file's assumptions
 * about it. That is exactly how `git checkout -- <name>` looked correct while
 * meaning "restore this path".
 */

/**
 * A budget sized for what these tests actually do, replacing vitest's 5s
 * default — which is a default, not a decision anyone made about this file.
 *
 * Every case here spawns EIGHT git subprocesses against a real temp repo
 * (`init`, two `config`s, `add`, `commit`, then `readGitInfo`'s own reads),
 * all of it real process + filesystem work. Fast on an idle machine, and on a
 * shared CI runner executing 88 spec files in parallel it crossed 5s and
 * failed on wall-clock alone — never on an assertion.
 *
 * This is not a retry around nondeterminism: the outcome is deterministic and
 * the assertions are untouched. Mocking `execFile` to make it fast is the
 * change that WOULD weaken it, for the reason the block above gives.
 */
vi.setConfig({ testTimeout: 30_000 });

let dir = '';
/** Extra checkouts a case added with `git worktree add`, removed with `dir`. */
let worktrees: string[] = [];

const run = (args: string[], cwd = dir): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * Like {@link run}, but for a git command that is EXPECTED to exit non-zero —
 * a conflicted `merge` exits 1 by design, and only the resulting repo state
 * matters to the tests that use this.
 */
const runIgnoringFailure = (args: string[], cwd = dir): void => {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  } catch {
    // Intentional: the caller wants the state a failing command leaves behind.
  }
};

/** A repo on `main` with one commit. */
function initRepo(): void {
  run(['init', '-b', 'main', '-q', dir], tmpdir());
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-git-'));
  worktrees = [];
});

afterEach(() => {
  for (const worktree of worktrees) {
    rmSync(worktree, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('readGitInfo', () => {
  it('reports a plain folder as not a repo', async () => {
    expect(await readGitInfo(dir)).toEqual({
      isRepo: false,
      branch: null,
      branches: [],
      dirty: false,
      worktrees: [],
    });
  });

  it('reports the current branch, every local branch, and a clean tree', async () => {
    initRepo();
    run(['branch', 'feat/chips']);

    expect(await readGitInfo(dir)).toEqual({
      isRepo: true,
      branch: 'main',
      branches: ['feat/chips', 'main'],
      dirty: false,
      worktrees: [],
    });
  });

  it('reports an uncommitted change as dirty', async () => {
    initRepo();
    writeFileSync(join(dir, 'README.md'), 'edited\n');

    expect((await readGitInfo(dir)).dirty).toBe(true);
  });

  it('reports an untracked file as dirty', async () => {
    // An untracked file is lost by a checkout that would overwrite it, so the
    // guard has to treat it as work in progress just like a modification.
    initRepo();
    writeFileSync(join(dir, 'scratch.txt'), 'notes\n');

    expect((await readGitInfo(dir)).dirty).toBe(true);
  });

  it('names no branch on a detached HEAD', async () => {
    initRepo();
    run(['checkout', '-q', '--detach']);

    const info = await readGitInfo(dir);
    expect(info.isRepo).toBe(true);
    expect(info.branch).toBeNull();
  });

  it('names the branches other worktrees hold, and where they are', async () => {
    initRepo();
    const other = join(dir, '..', `${basename(dir)}-wt`);
    run(['worktree', 'add', '-q', '-b', 'feat/elsewhere', other]);
    worktrees.push(other);

    const info = await readGitInfo(dir);

    // Still a branch of this repo — it is listed, and it is one the user can
    // work on. What the extra field says is WHERE.
    expect(info.branches).toContain('feat/elsewhere');
    expect(info.worktrees).toEqual([
      { branch: 'feat/elsewhere', path: realpathSync(other) },
    ]);
  });

  it('does NOT report this folder’s own branch as held elsewhere', async () => {
    // The listing includes the current worktree, so without the self-filter the
    // branch already checked out here would read as unreachable — and the chip
    // would refuse to switch back to it.
    initRepo();
    const other = join(dir, '..', `${basename(dir)}-wt`);
    run(['worktree', 'add', '-q', '-b', 'feat/elsewhere', other]);
    worktrees.push(other);

    expect((await readGitInfo(dir)).worktrees).not.toContainEqual(
      expect.objectContaining({ branch: 'main' }),
    );
  });

  it('reports the worktrees from a SUBDIRECTORY of the checkout too', async () => {
    // A run's folder is routinely a subdirectory. `worktree list` prints
    // checkout ROOTS, so a self-filter comparing against the folder itself
    // would match nothing here and file this checkout's own branch as held
    // somewhere else.
    initRepo();
    const other = join(dir, '..', `${basename(dir)}-wt`);
    run(['worktree', 'add', '-q', '-b', 'feat/elsewhere', other]);
    worktrees.push(other);
    mkdirSync(join(dir, 'apps', 'ui'), { recursive: true });

    const info = await readGitInfo(join(dir, 'apps', 'ui'));

    expect(info.worktrees).toEqual([
      { branch: 'feat/elsewhere', path: realpathSync(other) },
    ]);
  });
});

describe('readOriginOwner', () => {
  // Both URL forms git writes, because which one a checkout carries is the
  // user's clone choice — and the owner is what tells THEIR fork's pull request
  // apart from a stranger's.
  it('reads the owner from an ssh remote', async () => {
    initRepo();
    run(['remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);

    expect(await readOriginOwner(dir)).toBe('acme');
  });

  it('reads the owner from an https remote', async () => {
    initRepo();
    run(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);

    expect(await readOriginOwner(dir)).toBe('acme');
  });

  it('reads the owner from a url with no .git suffix', async () => {
    initRepo();
    run(['remote', 'add', 'origin', 'https://github.com/acme/widgets']);

    expect(await readOriginOwner(dir)).toBe('acme');
  });

  it('answers null when the folder has no origin', async () => {
    initRepo();

    expect(await readOriginOwner(dir)).toBeNull();
  });

  it('answers null for a plain folder', async () => {
    expect(await readOriginOwner(dir)).toBeNull();
  });
});

describe('switchBranch', () => {
  it('switches a clean tree', async () => {
    initRepo();
    run(['branch', 'feat/chips']);

    expect(await switchBranch(dir, 'feat/chips')).toEqual({
      ok: true,
      branch: 'feat/chips',
      error: null,
      dirty: false,
      worktree: null,
    });
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/chips');
  });

  it('switches a branch even when a FILE shares its name', async () => {
    // The regression pin for the guard's argument form. `git checkout <name>`
    // resolves a branch OR a pathspec, and `git checkout -- <name>` is
    // unambiguously the pathspec form: against this repo it would restore the
    // file and leave HEAD on main, silently discarding the edit below.
    initRepo();
    run(['branch', 'release']);
    writeFileSync(join(dir, 'release'), 'committed\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'add a file named like the branch']);
    writeFileSync(join(dir, 'release'), 'UNCOMMITTED EDIT\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'edit it']);

    const result = await switchBranch(dir, 'release');

    expect(result.ok).toBe(true);
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('release');
  });

  it('refuses a branch another worktree holds, naming that folder', async () => {
    // The reported case: starting a thread on a branch that is checked out in a
    // sibling worktree. git can never do this, and its own refusal is a
    // `fatal:` line the app used to print verbatim.
    initRepo();
    const other = join(dir, '..', `${basename(dir)}-wt`);
    run(['worktree', 'add', '-q', '-b', 'feat/elsewhere', other]);
    worktrees.push(other);

    const result = await switchBranch(dir, 'feat/elsewhere');

    expect(result.ok).toBe(false);
    // The way out, and the whole reason this is a field rather than prose: the
    // renderer offers THIS folder.
    expect(result.worktree).toBe(realpathSync(other));
    expect(result.dirty).toBe(false);
    // Not git's own wording — which is locale-dependent — and no `fatal:`.
    expect(result.error).toContain('feat/elsewhere');
    expect(result.error).not.toContain('fatal');
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('reports the worktree refusal even on a DIRTY tree, and offers no pull', async () => {
    // Ordering matters: committing or pulling cannot make git check a branch
    // out twice, so the dirty refusal — whose whole point is the Pull offer
    // beside it — must not stand in front of this one and hand the user a
    // control that cannot help.
    initRepo();
    const other = join(dir, '..', `${basename(dir)}-wt`);
    run(['worktree', 'add', '-q', '-b', 'feat/elsewhere', other]);
    worktrees.push(other);
    writeFileSync(join(dir, 'README.md'), 'work in progress\n');

    const result = await switchBranch(dir, 'feat/elsewhere');

    expect(result.worktree).toBe(realpathSync(other));
    expect(result.dirty).toBe(false);
  });

  it('refuses over uncommitted changes and leaves the branch alone', async () => {
    initRepo();
    run(['branch', 'feat/chips']);
    writeFileSync(join(dir, 'README.md'), 'work in progress\n');

    const result = await switchBranch(dir, 'feat/chips');

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Uncommitted changes');
    // The refusal names itself as the DIRTY one, which is what earns it a
    // warning tone and the Pull offer rather than a red error strip.
    expect(result.dirty).toBe(true);
    expect(result.branch).toBe('main');
    // The guard's whole purpose: the tree is untouched.
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(run(['status', '--porcelain'])).toContain('README.md');
  });

  it('is a no-op when already on the branch, dirty tree or not', async () => {
    // Re-picking the current row must not be refused — nothing would move.
    initRepo();
    writeFileSync(join(dir, 'README.md'), 'work in progress\n');

    expect(await switchBranch(dir, 'main')).toEqual({
      ok: true,
      branch: 'main',
      error: null,
      dirty: false,
      worktree: null,
    });
  });

  it('surfaces git’s own message for a branch that does not exist', async () => {
    initRepo();

    const result = await switchBranch(dir, 'nope');

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(run(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });

  it('refuses a non-repo folder', async () => {
    expect(await switchBranch(dir, 'main')).toEqual({
      ok: false,
      branch: null,
      error: 'Not a git repository',
      dirty: false,
      worktree: null,
    });
  });
});

describe('pullBranch', () => {
  /**
   * A real upstream: an `origin` repo with a second commit in it, and `dir`
   * cloned off it and one commit behind. Real repositories throughout, for the
   * reason at the top of this file — what is under test is git's own behaviour
   * when a fast-forward meets a dirty tree, and a mocked `execFile` would only
   * replay this file's guess about it.
   */
  let origin = '';

  function initClone(): void {
    origin = mkdtempSync(join(tmpdir(), 'geniro-git-origin-'));
    run(['init', '-b', 'main', '-q', origin], tmpdir());
    run(['config', 'user.email', 'test@example.com'], origin);
    run(['config', 'user.name', 'Test'], origin);
    writeFileSync(join(origin, 'README.md'), 'hello\n');
    run(['add', '.'], origin);
    run(['commit', '-q', '-m', 'init'], origin);
    // Clone into the ALREADY-CREATED temp dir, which git only allows when it is
    // empty — it is, `beforeEach` just made it.
    run(['clone', '-q', origin, dir], tmpdir());
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
  }

  /** One more commit on the upstream, so the clone is a fast-forward behind. */
  function advanceOrigin(): void {
    writeFileSync(join(origin, 'UPSTREAM.md'), 'from the remote\n');
    run(['add', '.'], origin);
    run(['commit', '-q', '-m', 'upstream moved'], origin);
  }

  afterEach(() => {
    if (origin !== '') {
      rmSync(origin, { recursive: true, force: true });
      origin = '';
    }
  });

  it('fast-forwards a clean clone', async () => {
    initClone();
    advanceOrigin();

    expect(await pullBranch(dir)).toEqual({
      ok: true,
      branch: 'main',
      error: null,
      stashLeft: null,
    });
    expect(run(['log', '-1', '--format=%s'])).toBe('upstream moved');
  });

  it('keeps uncommitted work across the pull — the whole point of the button', async () => {
    // The reported ask, in one case: the branch moves AND the edits are still
    // there afterwards. A pull that quietly stashed them and left them stashed
    // would look exactly like the work had been destroyed.
    initClone();
    advanceOrigin();
    writeFileSync(join(dir, 'README.md'), 'work in progress\n');
    writeFileSync(join(dir, 'NEW.md'), 'not even added yet\n');

    const result = await pullBranch(dir);

    expect(result).toEqual({
      ok: true,
      branch: 'main',
      error: null,
      stashLeft: null,
    });
    expect(run(['log', '-1', '--format=%s'])).toBe('upstream moved');
    const status = run(['status', '--porcelain']);
    expect(status).toContain('README.md');
    // `--include-untracked`, so a file the user had not added yet comes back
    // too. Without it the pull silently swallows brand-new files.
    expect(status).toContain('NEW.md');
    expect(run(['stash', 'list'])).toBe('');
  });

  it('puts the work back even when the pull itself is refused', async () => {
    // The one outcome this must never produce is hidden work: stash, fail,
    // walk away. Diverging the clone makes `--ff-only` refuse for real.
    initClone();
    advanceOrigin();
    writeFileSync(join(dir, 'LOCAL.md'), 'a local commit\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'diverge']);
    writeFileSync(join(dir, 'README.md'), 'work in progress\n');

    const result = await pullBranch(dir);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.stashLeft).toBeNull();
    expect(run(['status', '--porcelain'])).toContain('README.md');
    expect(run(['stash', 'list'])).toBe('');
  });

  it('refuses a folder that is not a repository', async () => {
    expect(await pullBranch(dir)).toEqual({
      ok: false,
      branch: null,
      error: 'Not a git repository',
      stashLeft: null,
    });
  });

  it('refuses a detached HEAD rather than guessing which ref to pull', async () => {
    initClone();
    run(['checkout', '-q', '--detach', 'HEAD']);

    const result = await pullBranch(dir);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Detached HEAD');
  });

  it('aborts rather than pulling when the stash push itself fails', async () => {
    // `git stash push` refuses outright on unmerged paths ("needs merge"),
    // which is a real, reproducible way to make the push itself fail without
    // mocking or racing a timeout. A merge conflict is unrelated to the
    // remote — it only needs to leave the tree dirty via unmerged entries.
    initClone();
    run(['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(dir, 'README.md'), 'feature change\n');
    run(['commit', '-q', '-am', 'feature change']);
    run(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'README.md'), 'main change\n');
    run(['commit', '-q', '-am', 'main change']);
    runIgnoringFailure(['merge', 'feature', '-q']);
    expect(run(['status', '--porcelain'])).toContain('UU README.md');

    const result = await pullBranch(dir);

    expect(result.ok).toBe(false);
    expect(result.stashLeft).toBeNull();
    // The stash push's OWN reason, not `git pull`'s — which would read
    // "Pulling is not possible…" instead, and only appears if the code went
    // on to run `pull` after a stash push it never checked the result of.
    expect(result.error).toContain('could not write index');
    // The tree is exactly as it was left by the conflict — nothing was moved
    // aside, and no fast-forward was attempted against it.
    expect(run(['status', '--porcelain'])).toContain('UU README.md');
    expect(run(['stash', 'list'])).toBe('');
  });

  it('pops only its own entry, leaving an earlier unrelated stash in place', async () => {
    // The pull's own entry is what
    // gets identified and popped, and an entry it did not push (however it
    // got there — a concurrent writer being the case that motivates the
    // check) is never touched.
    initClone();
    advanceOrigin();
    writeFileSync(join(dir, 'OTHER.md'), 'somebody else’s work\n');
    run(['add', '.']);
    run(['stash', 'push', '--message', 'not this pull']);
    expect(run(['stash', 'list'])).toContain('not this pull');

    writeFileSync(join(dir, 'README.md'), 'work in progress\n');

    const result = await pullBranch(dir);

    expect(result).toEqual({
      ok: true,
      branch: 'main',
      error: null,
      stashLeft: null,
    });
    // This pull's own change came back…
    expect(run(['status', '--porcelain'])).toContain('README.md');
    // …and the unrelated entry beneath it was left alone, never popped into
    // the tree.
    const stashList = run(['stash', 'list']);
    expect(stashList).toContain('not this pull');
    expect(run(['status', '--porcelain'])).not.toContain('OTHER.md');
  });
});

describe('pullStashIsOurs', () => {
  // The two mistakes this guards, each of which pops work the pull never moved.
  it('refuses a LEFTOVER entry the push did not create', () => {
    // `git stash push` on a tree that is not really dirty exits 0 and creates
    // nothing — reachable because a FAILED `git status` is reported as dirty. If
    // an earlier run's pop conflicted, its entry is still the tip and still
    // carries the message, so the subject alone says "mine".
    expect(pullStashIsOurs('abc123', 'abc123', 'On main: geniro: pull')).toBe(
      false,
    );
  });

  it('refuses a tip somebody ELSE pushed', () => {
    // A concurrent `git stash` in the user's own terminal moves the ref, so the
    // ref alone says "mine" too.
    expect(pullStashIsOurs('abc123', 'def456', 'On main: WIP')).toBe(false);
  });

  it('accepts only a moved ref carrying this pull’s own message', () => {
    expect(pullStashIsOurs('abc123', 'def456', 'On main: geniro: pull')).toBe(
      true,
    );
    // First stash in the repo: nothing before, something after.
    expect(pullStashIsOurs(null, 'def456', 'On main: geniro: pull')).toBe(true);
  });

  it('refuses when there is no stash at all', () => {
    expect(pullStashIsOurs(null, null, null)).toBe(false);
  });
});
