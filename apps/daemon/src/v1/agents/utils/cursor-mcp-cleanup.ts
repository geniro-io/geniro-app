import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * One-release cleanup for `.cursor/mcp.json` merges the DELETED legacy cursor
 * transport left behind in users' own worktrees.
 *
 * Until the ACP migration, driving a cursor caller node meant merging a
 * `geniro` MCP entry into the user's `.cursor/mcp.json`, journalling the merge
 * first, and undoing it when the turn settled. A crash — or a clean settle
 * whose restore failed — could strand that entry, plus a `.geniro-bak`
 * sibling and a `.geniro-tmp`, in a directory the user very likely has under
 * version control. The boot reconcile that undid all this was deleted with the
 * transport, so without this an upgrading user keeps that residue forever with
 * no code left that removes it.
 *
 * This is the CLEANUP half only: it reads the journal the old code wrote and
 * undoes what it names — or DECLINES to, when what it finds is not provably
 * ours (a `geniro` key we did not write, a symlink, content that no longer
 * parses). There is deliberately no merge path here — nothing in the daemon
 * writes to a user's `.cursor/mcp.json` any more, and nothing should be able
 * to again. Delete this module (and its `main.ts` call) one release after it
 * ships.
 */

/** The server key the legacy merge wrote — the only key we may remove. */
const GENIRO_MCP_SERVER_KEY = 'geniro';

/** One journalled merge, as the deleted transport recorded it. */
export interface CursorMergeJournalEntry {
  cwd: string;
  /** True when geniro created the file — cleanup may delete the empty shell. */
  created: boolean;
  /** The user's original file mode, to put back. */
  mode?: number;
  ts: number;
  /**
   * How many launches have tried and failed on this cwd. Absent on every
   * entry the old transport wrote — this is cleanup's own bookkeeping, added
   * when an entry is retained for another try.
   */
  attempts?: number;
}

type McpJson = { mcpServers?: Record<string, unknown> } & Record<
  string,
  unknown
>;

function isJournalEntry(value: unknown): value is CursorMergeJournalEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Partial<CursorMergeJournalEntry>;
  return (
    typeof entry.cwd === 'string' &&
    typeof entry.created === 'boolean' &&
    typeof entry.ts === 'number' &&
    (entry.mode === undefined || typeof entry.mode === 'number') &&
    (entry.attempts === undefined || typeof entry.attempts === 'number')
  );
}

/** Rewrite the journal with the entries still awaiting cleanup. */
export function writeMergeJournal(
  path: string,
  entries: CursorMergeJournalEntry[],
): void {
  // tmp + rename, matching the writer this replaces: an in-place truncate that
  // tears leaves an unparseable journal, and `readMergeJournal` reads that as
  // "nothing stranded" — silently abandoning every cwd still listed.
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(entries), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tmp, path);
}

export function readMergeJournal(path: string): CursorMergeJournalEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) && parsed.every(isJournalEntry) ? parsed : [];
  } catch {
    // Missing (the common case) or malformed — nothing we can act on.
    return [];
  }
}

function configPathOf(cwd: string): string {
  return join(cwd, '.cursor', 'mcp.json');
}

function lstatIfExists(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function parseFile(path: string): McpJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as McpJson)
      : null;
  } catch {
    return null;
  }
}

/**
 * What one cleanup attempt concluded. Every member names a CONCLUSION; what to
 * do about it (retry, give up, warn) is the caller's policy, not this file's.
 */
export type CleanupOutcome = 'cleaned' | 'failed' | 'foreign' | 'unresolved';

/** Whether a `geniro` entry carries the shape the legacy merge wrote. */
function isOurEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const record = entry as {
    url?: unknown;
    headers?: { Authorization?: unknown };
  };
  return (
    typeof record.url === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+\/v1\/mcp\//.test(record.url) &&
    typeof record.headers?.Authorization === 'string' &&
    record.headers.Authorization.startsWith('Bearer ')
  );
}

/**
 * Undo one journalled merge. Surgical by design: it removes ONLY the `geniro`
 * key from the file as it stands now, so anything the user has changed since
 * survives. A geniro-created file is deleted only when it is still exactly the
 * shell geniro wrote — any other content is the user's by definition.
 *
 * @returns
 * - `cleaned` — the residue is gone (or was already gone) for this cwd.
 * - `foreign` — the `geniro` key is not one we wrote, so the file was left
 *   untouched; it is the user's own server sharing the name.
 * - `unresolved` — we will not act on what we found (a symlink, a non-file, or
 *   content we refuse to guess at). Nothing was changed.
 * - `failed` — an unexpected error; nothing was completed, and the caller may
 *   choose to come back to it.
 */
export function cleanStrandedMerge(
  cwd: string,
  state: { created: boolean; mode?: number },
): CleanupOutcome {
  const path = configPathOf(cwd);
  const backup = `${path}.geniro-bak`;
  const tmp = `${path}.geniro-tmp`;
  try {
    // An absent worktree is NOT an absent config: a repo on a volume that
    // mounts late (or after a move) makes every lstat below return ENOENT,
    // which would otherwise read as "the user deleted their mcp.json" and
    // drop the entry — abandoning the residue this module exists to remove.
    if (lstatIfExists(cwd) === null) {
      return 'failed';
    }
    // Never follow a symlink into somewhere else on the user's disk.
    const cursorDirStat = lstatIfExists(join(cwd, '.cursor'));
    if (
      cursorDirStat?.isSymbolicLink() ||
      (cursorDirStat && !cursorDirStat.isDirectory())
    ) {
      return 'unresolved';
    }
    if (lstatIfExists(tmp)?.isSymbolicLink()) {
      return 'unresolved';
    }
    // A staging file orphaned between the old merge's write and its rename —
    // 0600, and holding a call token revoked when that daemon launch ended.
    rmSync(tmp, { force: true });

    // Full type check, not just symlink: this file gets READ below, and a FIFO
    // here would block readFileSync forever — inside the pre-listen boot path,
    // where no try/catch can recover from a block.
    const backupStat = lstatIfExists(backup);
    if (backupStat && !backupStat.isFile()) {
      return 'unresolved';
    }
    const pathStat = lstatIfExists(path);
    if (!pathStat) {
      // The worktree is there but the config is not — the user removed it
      // themselves. Their call; drop the backup.
      rmSync(backup, { force: true });
      return 'cleaned';
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return 'unresolved';
    }

    const parsed = parseFile(path);
    if (parsed === null) {
      // The file no longer parses, and by the time this runs the journal entry
      // may be weeks old — the backup is a stale snapshot, and the likeliest
      // reason for the parse failure is the user's own edit (a JSONC comment,
      // a trailing comma). Copying the backup over it would silently discard
      // whatever they added since. Leave BOTH files exactly where they are:
      // the content is theirs, and `.geniro-bak` is the breadcrumb they need
      // to finish by hand.
      return 'unresolved';
    }

    const servers = { ...parsed.mcpServers };
    const entry = servers[GENIRO_MCP_SERVER_KEY];
    // A `geniro` key we cannot recognise as ours is the user's own server that
    // happens to share the name. The merge this undoes refused to overwrite
    // exactly that case; deleting it here would be an unrecoverable loss (no
    // backup is written for a foreign key), so leave the file untouched.
    if (entry !== undefined && !isOurEntry(entry)) {
      return 'foreign';
    }

    // Deleting a file geniro created is judged on what is ACTUALLY on disk,
    // never on the post-removal projection: that projection synthesises an
    // `mcpServers` key, so `{}` — a file the user emptied by hand and kept —
    // would compare equal to the shell and be deleted with no backup.
    // Evaluated whether or not our key is still there, because a crash between
    // the old restore's write and its journal removal leaves the shell behind
    // with the key already gone, and that file is ours to remove.
    if (state.created && isGeniroShell(parsed, entry)) {
      rmSync(path, { force: true });
      rmSync(backup, { force: true });
      return 'cleaned';
    }

    if (entry !== undefined) {
      delete servers[GENIRO_MCP_SERVER_KEY];
      const result: McpJson = { ...parsed, mcpServers: servers };
      // Byte-fidelity fast path: when the file minus our key is semantically
      // identical to the backup, put the ORIGINAL bytes back so even the
      // user's formatting survives, rather than reformatting a file that is
      // very likely tracked in their repo. (A whitespace-only reformat they
      // made mid-turn is reverted by this — the cost of not rewriting every
      // untouched file.)
      const original = backupStat ? parseFile(backup) : null;
      if (
        original !== null &&
        JSON.stringify(result) === JSON.stringify(original)
      ) {
        replaceFile(path, readFileSync(backup), state.mode);
      } else {
        replaceFile(
          path,
          Buffer.from(JSON.stringify(result, null, 2), 'utf8'),
          state.mode,
        );
      }
    } else {
      // Our key is already gone, but the mode we set for the turn may not be:
      // the merge chmod'd the file to 0600 and journalled the user's original.
      // Putting that back is the one piece of their state we still hold.
      restoreMode(path, state.mode);
    }
    rmSync(backup, { force: true });
    return 'cleaned';
  } catch {
    // Nothing was completed. The caller decides whether this cwd is worth
    // another launch; the .geniro-bak is the user-visible breadcrumb meanwhile.
    return 'failed';
  }
}

/**
 * Whether the file on disk is still exactly the shell a geniro-CREATED merge
 * wrote — `{"mcpServers": {…}}` and nothing else at the top level, holding at
 * most our own entry. Anything more is the user's content.
 */
function isGeniroShell(parsed: McpJson, ourEntry: unknown): boolean {
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'mcpServers') {
    return false;
  }
  const servers = parsed.mcpServers;
  if (
    typeof servers !== 'object' ||
    servers === null ||
    Array.isArray(servers)
  ) {
    return false;
  }
  const serverKeys = Object.keys(servers);
  return ourEntry === undefined
    ? serverKeys.length === 0
    : serverKeys.length === 1 && serverKeys[0] === GENIRO_MCP_SERVER_KEY;
}

/**
 * Replace `path` atomically via a staging sibling. `writeFileSync` on the
 * path itself would follow a symlink planted between the lstat above and the
 * write, and `wx` (O_EXCL) refuses to follow one planted at the staging path —
 * which is exactly why the merge writer this module undoes did the same.
 */
function replaceFile(
  path: string,
  bytes: Buffer,
  mode: number | undefined,
): void {
  const staging = `${path}.geniro-tmp`;
  rmSync(staging, { force: true });
  writeFileSync(staging, bytes, { mode: 0o600, flag: 'wx' });
  if (mode !== undefined) {
    // Masked: the mode is journal data, and a tampered value must not widen
    // permissions beyond what a file mode can legitimately carry.
    chmodSync(staging, mode & 0o777);
  }
  renameSync(staging, path);
}

function restoreMode(path: string, mode: number | undefined): void {
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}
