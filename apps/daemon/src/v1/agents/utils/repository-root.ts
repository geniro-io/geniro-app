import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';

/**
 * The REPOSITORY a folder belongs to: the nearest folder at or above it
 * holding a `.git` entry — and for a git WORKTREE, the MAIN repository the
 * worktree was cut from — or the folder itself when it is in no repository.
 *
 * Agent-agnostic git semantics, and two readers need exactly this answer:
 * claude keys its per-project state by it (`claudeProjectKey`, which carries
 * the probe and the bundle transcription this was written from), and the
 * Stats page files spend under it, so a task's worktree is counted as the
 * project it works on rather than as a project of its own.
 *
 * - the starting folder is its real path, NFC-normalized — so a symlinked or
 *   `/tmp`-style path resolves to where it really is;
 * - walk UP from it for the first `.git` ENTRY, a directory or a file, a
 *   symlink counting when it names either;
 * - that root's `.git`, when it is a FILE naming a worktree gitdir, is followed
 *   back to the repository it belongs to — only after the gitdir's own
 *   `commondir` and `gitdir` files agree that it is one, so a stray or
 *   hand-written `gitdir:` line resolves to the folder itself;
 * - and the result is `path.normalize`d.
 *
 * Never throws. A folder that cannot be resolved answers as itself.
 */
export async function repositoryRootOf(cwd: string): Promise<string> {
  const start = nfc(resolve(await realpath(cwd).catch(() => cwd)));
  const root = await gitRootOf(start);
  return normalize(root === null ? start : await canonicalRootOf(root));
}

/**
 * The MAIN repository a folder inside a linked git worktree belongs to, or
 * null when the folder is not inside one — a folder in an ordinary checkout,
 * in no repository, or that no longer exists.
 *
 * Narrower than {@link repositoryRootOf} on purpose: it never folds an
 * ordinary subfolder into its repository's root, so a caller can treat a
 * worktree as its repository without re-filing every folder that happens to
 * sit inside one (a home directory kept under git would otherwise swallow
 * every project on the machine).
 */
export async function mainRepositoryOfWorktree(
  cwd: string,
): Promise<string | null> {
  const start = nfc(resolve(await realpath(cwd).catch(() => cwd)));
  const root = await gitRootOf(start);
  if (root === null) {
    return null;
  }
  const canonical = await canonicalRootOf(root);
  return canonical === root ? null : normalize(canonical);
}

/** Every path is keyed NFC-normalized, as claude keys its own. */
function nfc(path: string): string {
  return path.normalize('NFC');
}

/**
 * The nearest folder at or above `start` holding a `.git` entry, or null.
 *
 * The filesystem root is checked too.
 */
async function gitRootOf(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    if (await isGitEntry(join(dir, '.git'))) {
      return nfc(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** A `.git` that is a directory or a file — through a symlink too. */
async function isGitEntry(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    const real = entry.isSymbolicLink() ? await stat(path) : entry;
    return real.isDirectory() || real.isFile();
  } catch {
    return false;
  }
}

/**
 * The repository a git root belongs to: `root` itself, unless its `.git` is a
 * worktree pointer that checks out, in which case the main repository.
 */
async function canonicalRootOf(root: string): Promise<string> {
  let pointer: string;
  try {
    // A `.git` DIRECTORY throws EISDIR here, and that is the ordinary case:
    // the root is a repository of its own.
    pointer = (await readFile(join(root, '.git'), 'utf8')).trim();
  } catch {
    return root;
  }
  if (!pointer.startsWith('gitdir:')) {
    return root;
  }
  const gitdir = resolve(root, pointer.slice('gitdir:'.length).trim());
  const commondirValue = await readPlainFile(join(gitdir, 'commondir'));
  if (commondirValue === null) {
    // A submodule's gitdir has no `commondir`: it is a repository of its own,
    // keyed where it is checked out.
    return root;
  }
  const commonDir = resolve(gitdir, commondirValue);
  // The gitdir must be one of the common dir's own worktrees…
  if (resolve(dirname(gitdir)) !== join(commonDir, 'worktrees')) {
    return root;
  }
  // …and must point BACK at this root, or it is somebody else's worktree entry.
  const backValue = await readPlainFile(join(gitdir, 'gitdir'));
  if (backValue === null) {
    return root;
  }
  const back = await realpath(resolve(gitdir, backValue)).catch(() => null);
  const own = await realpath(root).catch(() => null);
  if (back === null || own === null || back !== join(own, '.git')) {
    return root;
  }
  if (basename(commonDir) !== '.git') {
    // A BARE repository's worktree: keyed by the bare repository itself,
    // unless that directory is somehow a checkout of its own.
    return (await isGitEntry(join(commonDir, '.git'))) ? root : nfc(commonDir);
  }
  return nfc(dirname(commonDir));
}

/**
 * The trimmed contents of a REGULAR file, or null — a symlink or anything
 * else is refused.
 */
async function readPlainFile(path: string): Promise<string | null> {
  try {
    if (!(await lstat(path)).isFile()) {
      return null;
    }
    const value = (await readFile(path, 'utf8')).trim();
    return value === '' ? null : value;
  } catch {
    return null;
  }
}
