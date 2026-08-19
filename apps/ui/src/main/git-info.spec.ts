import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pullBranch, readGitInfo, switchBranch } from './git-info';

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

const run = (args: string[], cwd = dir): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readGitInfo', () => {
  it('reports a plain folder as not a repo', async () => {
    expect(await readGitInfo(dir)).toEqual({
      isRepo: false,
      branch: null,
      branches: [],
      dirty: false,
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
});
