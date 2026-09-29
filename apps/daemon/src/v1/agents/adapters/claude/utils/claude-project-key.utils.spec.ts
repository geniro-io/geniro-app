import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeProjectKey } from './claude-project-key.utils';

let root: string;

beforeEach(() => {
  // Canonicalized: on macOS the tmpdir sits under `/var` → `/private/var`, and
  // the key is taken from the REAL path, as the CLI takes it.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-project-key-')));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory under the fixture root, created with its parents. */
function dir(...segments: string[]): string {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
}

/** A repository with an ordinary `.git` DIRECTORY. */
function repository(name: string): string {
  const repo = dir(name);
  dir(name, '.git');
  return repo;
}

/**
 * A linked worktree of `repo`, laid out byte-for-byte as `git worktree add`
 * writes it: a `.git` FILE in the worktree naming its gitdir, and in that
 * gitdir a `commondir` pointing back at the repository's `.git` and a `gitdir`
 * pointing back at the worktree.
 */
function worktree(repo: string, name: string): string {
  const tree = dir(name);
  const gitdir = dir(repo.slice(root.length + 1), '.git', 'worktrees', name);
  writeFileSync(join(tree, '.git'), `gitdir: ${gitdir}\n`);
  writeFileSync(join(gitdir, 'commondir'), '../..\n');
  writeFileSync(join(gitdir, 'gitdir'), `${join(tree, '.git')}\n`);
  return tree;
}

describe('claudeProjectKey', () => {
  it('keys a folder outside any repository as itself', async () => {
    const folder = dir('plain', 'inner');

    await expect(claudeProjectKey(folder)).resolves.toBe(folder);
  });

  it('keys a SUBFOLDER of a repository by the repository root', async () => {
    // Probe-verified on 2.1.280: from `repo/sub`, `projects[repo/sub]` left the
    // server dialled and `projects[repo]` switched it off. Keyed by the cwd, the
    // toggle wrote the first and changed nothing.
    const repo = repository('repo');
    const sub = dir('repo', 'packages', 'app');

    await expect(claudeProjectKey(sub)).resolves.toBe(repo);
  });

  it('keys a git WORKTREE by the main repository it was cut from', async () => {
    // Every task card runs in a worktree, so this is the common case rather
    // than an edge: `projects[<worktree>]` did nothing on the probe, and
    // `projects[<main repo>]` switched the server off.
    const repo = repository('repo');
    const tree = worktree(repo, 'wt');

    await expect(claudeProjectKey(tree)).resolves.toBe(repo);
  });

  it('keys a subfolder of a worktree by the main repository too', async () => {
    const repo = repository('repo');
    const tree = worktree(repo, 'wt');
    const sub = dir('wt', 'src');

    expect(sub.startsWith(tree)).toBe(true);
    await expect(claudeProjectKey(sub)).resolves.toBe(repo);
  });

  it('keys by the REAL path, so a symlinked folder lands on the same entry', async () => {
    // The CLI starts from `realpathSync(process.cwd())`.
    const repo = repository('repo');
    const link = join(root, 'alias');
    symlinkSync(repo, link);

    await expect(claudeProjectKey(link)).resolves.toBe(repo);
  });

  it('does NOT follow a worktree pointer whose gitdir does not point back', async () => {
    // The CLI cross-checks the gitdir's own `gitdir` file against the folder
    // before trusting a `.git` pointer — a copied or hand-written one names
    // somebody else's worktree entry and must not redirect this folder there.
    const repo = repository('repo');
    const tree = worktree(repo, 'wt');
    const impostor = dir('impostor');
    writeFileSync(
      join(impostor, '.git'),
      `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`,
    );

    expect(tree).not.toBe(impostor);
    await expect(claudeProjectKey(impostor)).resolves.toBe(impostor);
  });

  it('keys a SUBMODULE checkout as itself, not as its superproject', async () => {
    // A submodule's `.git` file points into `.git/modules/<name>`, which has
    // no `commondir` — it is a repository of its own.
    const repo = repository('super');
    const modules = dir('super', '.git', 'modules', 'lib');
    const lib = dir('super', 'lib');
    writeFileSync(join(lib, '.git'), `gitdir: ${modules}\n`);

    expect(lib.startsWith(repo)).toBe(true);
    await expect(claudeProjectKey(lib)).resolves.toBe(lib);
  });

  it('keys a folder that does not exist as itself rather than throwing', async () => {
    const missing = join(root, 'gone');

    await expect(claudeProjectKey(missing)).resolves.toBe(missing);
  });
});
