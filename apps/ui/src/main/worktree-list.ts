/** One record of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  /** The full ref (`refs/heads/x`), or null for a detached or bare entry. */
  branch: string | null;
  /** git still lists it, but its directory is gone. */
  prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain`, in git's order — the main checkout
 * (or the bare repository) first.
 *
 * `separator` is the framing: `\0` for `-z`, which keeps a path holding a
 * newline as one path, else `\n`. Either way an empty field ends a record.
 */
export function parseWorktreeList(
  listing: string,
  separator: '\0' | '\n' = '\0',
): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const field of listing.split(separator)) {
    if (field.startsWith('worktree ')) {
      current = {
        path: field.slice('worktree '.length),
        branch: null,
        prunable: false,
      };
      entries.push(current);
    } else if (current === null) {
      continue;
    } else if (field.startsWith('branch ')) {
      current.branch = field.slice('branch '.length);
    } else if (field === 'prunable' || field.startsWith('prunable ')) {
      current.prunable = true;
    }
  }
  return entries;
}

/**
 * List a repository's worktrees through the caller's own git runner, or null
 * when git cannot answer.
 *
 * `-z` first; git before 2.36 does not know it for this command, and its
 * newline framing misreads only a path that itself holds a newline. The plain
 * form is tried only on such a git — any other failure (a timeout, a missing
 * folder) would just fail again, at the cost of a second timeout.
 */
export async function readWorktreeEntries(
  run: (args: string[]) => Promise<string | null>,
): Promise<WorktreeEntry[] | null> {
  const framed = await run(['worktree', 'list', '--porcelain', '-z']);
  if (framed !== null) {
    return parseWorktreeList(framed, '\0');
  }
  const version = await run(['version']);
  if (version === null || !predatesListZ(version)) {
    return null;
  }
  const plain = await run(['worktree', 'list', '--porcelain']);
  return plain === null ? null : parseWorktreeList(plain.trimEnd(), '\n');
}

/** Whether `git version` names a git before 2.36. */
function predatesListZ(version: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(version);
  if (match === null) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < 2 || (major === 2 && minor < 36);
}
