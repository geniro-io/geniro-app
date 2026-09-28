import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';

/**
 * The key claude files a folder under in its home config's `projects` map.
 *
 * NOT the folder itself, and that is the whole reason this exists: geniro
 * wrote the MCP toggle to `projects[<cwd>]` and the CLI never read it. The CLI
 * keys project state by the REPOSITORY a folder belongs to — and for a git
 * worktree, by the MAIN repository the worktree was cut from — so a chat
 * running in a subfolder, or in any worktree (every task card runs in one),
 * had a switch that moved on screen and changed nothing. Probe-verified on
 * 2.1.280 under an isolated `CLAUDE_CONFIG_DIR`: from `repo/sub`,
 * `projects[repo/sub].disabledMcpServers` left the server dialled and
 * `projects[repo]` disabled it; from a worktree, `projects[<worktree>]` did
 * nothing and `projects[<main repo>]` disabled it.
 *
 * Transcribed from the shipped 2.1.280 bundle rather than inferred from those
 * two probes:
 *
 * - the starting folder is `realpathSync(process.cwd())`, NFC-normalized
 *   (`pIr`) — so a symlinked or `/tmp`-style path is keyed by where it really is;
 * - walk UP from it for the first `.git` ENTRY, a directory or a file, a
 *   symlink counting when it names either (`Kt` → `Ce`);
 * - that root's `.git`, when it is a FILE naming a worktree gitdir, is followed
 *   back to the repository it belongs to — only after the gitdir's own
 *   `commondir` and `gitdir` files agree that it is one (`ve` → `Bt`), so a
 *   stray or hand-written `gitdir:` line resolves to the folder itself;
 * - no repository at all → the folder itself;
 * - and the result is `path.normalize`d (`nrt` → `V$`).
 *
 * The CLI's extra path-safety guards (UNC and traversal refusals on the
 * `gitdir:` values) are not repeated: a value they refuse is also one the
 * cross-checks below refuse, which lands on the same answer — the worktree's
 * own root.
 *
 * Never throws. A folder that cannot be resolved keys as itself, which is what
 * the CLI does with a `cwd` it cannot canonicalize.
 */
export async function claudeProjectKey(cwd: string): Promise<string> {
  const start = nfc(resolve(await realpath(cwd).catch(() => cwd)));
  const root = await gitRootOf(start);
  return normalize(root === null ? start : await canonicalRootOf(root));
}

/** The CLI normalizes every path it keys on to NFC. */
function nfc(path: string): string {
  return path.normalize('NFC');
}

/**
 * The nearest folder at or above `start` holding a `.git` entry, or null.
 *
 * The filesystem root is checked too, as the CLI's own walk does.
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
 * else is refused, as the CLI refuses it (`tR`).
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
