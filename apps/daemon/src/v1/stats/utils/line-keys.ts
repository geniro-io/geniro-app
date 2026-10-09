import { createHash } from 'node:crypto';

/**
 * The keys a folder's lines are filed under.
 *
 * Hashed rather than joined, because the parts are a path and a branch name and no
 * separator is guaranteed absent from either. JSON keeps the parts apart, and a hash keeps
 * the key a fixed size for the index.
 */
function hashParts(parts: readonly (string | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** One repository and branch: the address a baseline is kept under. */
export function folderKeyOf(root: string, branch: string | null): string {
  return hashParts(['folder', root, branch]);
}

/**
 * One series of lines totals: a folder and branch measured against one baseline. A baseline
 * that is replaced starts a new series, so totals measured against two different commits
 * are never compared with each other.
 */
export function lineKeyOf(
  root: string,
  branch: string | null,
  baseSha: string,
): string {
  return hashParts(['lines', root, branch, baseSha]);
}

/**
 * The series a lines row belongs to. A row written before baselines existed has no key and
 * was measured against its own thread's start commit, so it is its thread's own series.
 */
export function snapshotLineKey(row: {
  runId: string;
  lineKey: string | null;
}): string {
  return row.lineKey ?? `${LEGACY_LINE_KEY_PREFIX}${row.runId}`;
}

/** What a row with no line key is filed under: its own thread. */
const LEGACY_LINE_KEY_PREFIX = 'run:';

/**
 * {@link snapshotLineKey} in SQL, over the `activity` alias, for a query that groups rows by
 * series. Built from the same prefix, so the database and the fold cannot file one row under
 * two keys.
 */
export const SNAPSHOT_LINE_KEY_SQL = `coalesce(activity.line_key, '${LEGACY_LINE_KEY_PREFIX}' || activity.run_id)`;
