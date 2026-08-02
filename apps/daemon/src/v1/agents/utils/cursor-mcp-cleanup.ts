import {
  chmodSync,
  copyFileSync,
  existsSync,
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
 * undoes what it names. There is deliberately no merge path here — nothing in
 * the daemon writes to a user's `.cursor/mcp.json` any more, and nothing
 * should be able to again. Delete this module (and its `main.ts` call) one
 * release after it ships.
 */

/** The server key the legacy merge wrote — the only key we may remove. */
const GENIRO_MCP_SERVER_KEY = 'geniro';

/** What a geniro-CREATED file reduces to once our key is gone. */
const EMPTY_SHELL = JSON.stringify({ mcpServers: {} });

/** One journalled merge, as the deleted transport recorded it. */
interface CursorMergeJournalEntry {
  cwd: string;
  /** True when geniro created the file — cleanup may delete the empty shell. */
  created: boolean;
  /** The user's original file mode, to put back. */
  mode?: number;
  ts: number;
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
    (entry.mode === undefined || typeof entry.mode === 'number')
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
 * What one cleanup attempt concluded.
 *
 * `retry` is the only outcome worth another launch; `foreign` and `unresolved`
 * are decisions not to touch the file, so retrying them forever would keep
 * this module — and its boot warning — alive past the release that removes it.
 */
export type CleanupOutcome = 'cleaned' | 'retry' | 'foreign' | 'unresolved';

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
 * survives. A geniro-created file is deleted only when removing that key
 * leaves exactly the shell geniro itself wrote — any other content is the
 * user's by definition.
 */
export function cleanStrandedMerge(
  cwd: string,
  state: { created: boolean; mode?: number },
): CleanupOutcome {
  const path = configPathOf(cwd);
  const backup = `${path}.geniro-bak`;
  const tmp = `${path}.geniro-tmp`;
  try {
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

    if (lstatIfExists(backup)?.isSymbolicLink()) {
      return 'unresolved';
    }
    const pathStat = lstatIfExists(path);
    if (!pathStat) {
      // The user deleted the file themselves — their call; drop the backup.
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
    delete servers[GENIRO_MCP_SERVER_KEY];
    const result: McpJson = { ...parsed, mcpServers: servers };

    // Evaluated whether or not our key was still present: a crash between the
    // old restore's write and its journal removal leaves the shell behind with
    // the key already gone, and that file is the one this module exists to
    // remove.
    if (state.created && JSON.stringify(result) === EMPTY_SHELL) {
      rmSync(path, { force: true });
      rmSync(backup, { force: true });
      return 'cleaned';
    }
    if (entry !== undefined) {
      // Byte-fidelity fast path: when the user made no mid-turn edits, the
      // file minus our key equals the backup — put the ORIGINAL bytes back so
      // even their formatting survives, rather than reformatting a file that
      // is very likely tracked in their repo.
      const original = existsSync(backup) ? parseFile(backup) : null;
      if (
        original !== null &&
        JSON.stringify(result) === JSON.stringify(original)
      ) {
        copyFileSync(backup, path);
      } else {
        writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
      }
      restoreMode(path, state.mode);
    }
    rmSync(backup, { force: true });
    return 'cleaned';
  } catch {
    // Best-effort: a retained journal entry is the next launch's second try,
    // and the .geniro-bak is the user-visible breadcrumb meanwhile.
    return 'retry';
  }
}

function restoreMode(path: string, mode: number | undefined): void {
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}
