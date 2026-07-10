import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type CursorMcpServerEntry,
  GENIRO_MCP_SERVER_KEY,
} from './cursor-mcp-entry';

/**
 * File mechanics for the per-turn `.cursor/mcp.json` merge — the ONE write
 * geniro ever makes inside a user's worktree. Hard rules (spec forbidden
 * actions): never overwrite user data — an unparseable file, a foreign
 * `geniro` key, or an unexpected `mcpServers` shape refuses instead of
 * writing; and every merge must be undone by {@link restoreGeniroEntry} on
 * turn end or by the boot reconcile.
 *
 * Restore is SURGICAL on every path — it removes only the `geniro` key from
 * the file as it is NOW, so edits the user made while the agent ran survive
 * (a geniro-CREATED file is deleted only when removing the key leaves the
 * empty shell geniro itself wrote — anything else in it is user data by
 * definition). The byte-level backup is the emergency path only (the current
 * file no longer parses).
 *
 * The merged file is chmod'd 0600 for the turn — it carries the caller's
 * bearer call token — and the user's original mode comes back on restore.
 */

export interface CursorMcpMergeState {
  /** True when geniro created the file (restore may delete the empty shell). */
  created: boolean;
  /** Original file mode to restore (absent when geniro created the file). */
  mode?: number;
}

export type CursorMcpMergeResult =
  ({ ok: true } & CursorMcpMergeState) | { ok: false; reason: string };

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

/** The backup sits next to the file so a user can spot and undo it by hand. */
export function backupPathOf(cwd: string): string {
  return `${configPathOf(cwd)}.geniro-bak`;
}

/** The atomic-write staging sibling — consumed by rename on a successful merge;
 *  only ever lingers if a crash struck between the write and the rename. */
function tmpPathOf(cwd: string): string {
  return `${configPathOf(cwd)}.geniro-tmp`;
}

type McpJson = { mcpServers?: Record<string, unknown> } & Record<
  string,
  unknown
>;

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

/** `mcpServers` must be a plain object, or the spread-merge would corrupt it
 *  (an array spreads into `{"0": …}` keys — a shape restore cannot undo). */
function hasMergeableServers(parsed: McpJson): boolean {
  const servers: unknown = parsed.mcpServers;
  return (
    servers === undefined ||
    (typeof servers === 'object' && servers !== null && !Array.isArray(servers))
  );
}

/** The exact shell a fresh geniro-created file reduces to once our key is
 *  removed — the only content restore may delete without losing user data. */
const EMPTY_SHELL = JSON.stringify({ mcpServers: {} });

/** Merge the geniro server entry into `<cwd>/.cursor/mcp.json`. */
export function mergeGeniroEntry(
  cwd: string,
  entry: CursorMcpServerEntry,
): CursorMcpMergeResult {
  const cursorDir = join(cwd, '.cursor');
  const path = configPathOf(cwd);
  const dirStat = lstatIfExists(cursorDir);
  if (dirStat?.isSymbolicLink() || (dirStat && !dirStat.isDirectory())) {
    return {
      ok: false,
      reason: `${cursorDir} is not a real directory — refusing to touch it`,
    };
  }
  const pathStat = lstatIfExists(path);
  if (pathStat?.isSymbolicLink()) {
    return {
      ok: false,
      reason: `${path} is a symbolic link — refusing to touch it`,
    };
  }
  if (!pathStat) {
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { mcpServers: { [GENIRO_MCP_SERVER_KEY]: entry } },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    return { ok: true, created: true };
  }
  if (!pathStat.isFile()) {
    return {
      ok: false,
      reason: `${path} is not a regular file — refusing to touch it`,
    };
  }
  const parsed = parseFile(path);
  if (parsed === null) {
    return {
      ok: false,
      reason: `${path} is not valid JSON — refusing to touch it`,
    };
  }
  if (!hasMergeableServers(parsed)) {
    return {
      ok: false,
      reason: `${path} has an mcpServers that is not an object — refusing to touch it`,
    };
  }
  if (parsed.mcpServers?.[GENIRO_MCP_SERVER_KEY] !== undefined) {
    return {
      ok: false,
      reason: `${path} already has an mcpServers.${GENIRO_MCP_SERVER_KEY} entry that is not ours — refusing to overwrite it`,
    };
  }
  const mode = statSync(path).mode & 0o777;
  const backup = backupPathOf(cwd);
  if (lstatIfExists(backup) !== null) {
    return {
      ok: false,
      reason: `${backup} already exists — refusing to overwrite recovery data`,
    };
  }
  const tmp = tmpPathOf(cwd);
  const tmpStat = lstatIfExists(tmp);
  if (tmpStat?.isSymbolicLink()) {
    return {
      ok: false,
      reason: `${tmp} is a symbolic link — refusing to touch it`,
    };
  }
  rmSync(tmp, { force: true });
  copyFileSync(path, backup, constants.COPYFILE_EXCL);
  // The merged file carries a bearer call token, so it must never be even
  // briefly world-readable. Write to a fresh sibling temp created 0600, then
  // renameSync it over the original (atomic replace) — a plain in-place
  // writeFileSync truncates the user's file while KEEPING its (often 0644)
  // mode, leaving the token exposed until a follow-up chmod. The rmSync clears
  // any temp a crashed turn stranded so the fresh 0600 create applies; the
  // 'wx' (O_EXCL) flag then refuses to follow a symlink planted at the temp
  // path rather than writing the token through it. Mirrors the create branch.
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        ...parsed,
        mcpServers: { ...parsed.mcpServers, [GENIRO_MCP_SERVER_KEY]: entry },
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  );
  renameSync(tmp, path);
  return { ok: true, created: false, mode };
}

/**
 * Undo one merge. Never throws — restore runs on settle paths and at boot,
 * where an fs error must leave the backup and journal entry for a later retry,
 * not take the turn or the boot down. False means automatic recovery is still
 * required.
 */
export function restoreGeniroEntry(
  cwd: string,
  state: CursorMcpMergeState,
): boolean {
  const path = configPathOf(cwd);
  const backup = backupPathOf(cwd);
  try {
    const cursorDirStat = lstatIfExists(join(cwd, '.cursor'));
    if (
      cursorDirStat?.isSymbolicLink() ||
      (cursorDirStat && !cursorDirStat.isDirectory())
    ) {
      return false;
    }
    // Sweep a temp orphaned by a crash between the merge's write and rename (a
    // successful merge renames it away). restoreGeniroEntry is the one cleanup
    // path both settle and the boot reconcile take, so this clears a stranded
    // 0600 temp holding an already-revoked token — no stray file left behind.
    const tmp = tmpPathOf(cwd);
    if (lstatIfExists(tmp)?.isSymbolicLink()) {
      return false;
    }
    rmSync(tmp, { force: true });
    const pathStat = lstatIfExists(path);
    if (!pathStat) {
      // The user removed the file mid-turn — their call; just drop the backup.
      if (lstatIfExists(backup)?.isSymbolicLink()) {
        return false;
      }
      rmSync(backup, { force: true });
      return true;
    }
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      return false;
    }
    if (lstatIfExists(backup)?.isSymbolicLink()) {
      return false;
    }
    const parsed = parseFile(path);
    if (parsed === null) {
      // Emergency path: the file no longer parses (a torn write?). Byte-restore
      // when a backup exists; a geniro-created file has none — the unparseable
      // content is the user's now, leave it alone.
      if (existsSync(backup)) {
        copyFileSync(backup, path);
        restoreMode(path, state.mode);
        rmSync(backup, { force: true });
        return true;
      }
      return false;
    }
    if (parsed.mcpServers?.[GENIRO_MCP_SERVER_KEY] !== undefined) {
      const servers = { ...parsed.mcpServers };
      delete servers[GENIRO_MCP_SERVER_KEY];
      const result: McpJson = { ...parsed, mcpServers: servers };
      if (state.created && JSON.stringify(result) === EMPTY_SHELL) {
        // Removing our key leaves exactly the shell geniro wrote — nothing of
        // the user's in it, so the created file may go. Any other content
        // (a replaced file, an added entry) is user data: fall through to the
        // surgical write instead of deleting it.
        rmSync(path, { force: true });
        rmSync(backup, { force: true });
        return true;
      }
      // Byte-fidelity fast path: when the user made no mid-turn edits, the
      // file minus our key equals the backup — put the ORIGINAL bytes back so
      // even the user's formatting survives. (Key order is stable through
      // parse/stringify, so string equality is a sound sameness check here.)
      const original = existsSync(backup) ? parseFile(backup) : null;
      if (
        original !== null &&
        JSON.stringify(result) === JSON.stringify(original)
      ) {
        copyFileSync(backup, path);
      } else {
        writeFileSync(path, JSON.stringify(result, null, 2), 'utf8');
      }
    }
    restoreMode(path, state.mode);
    rmSync(backup, { force: true });
    return true;
  } catch {
    // Best-effort by contract; a leftover .geniro-bak is the user-visible
    // breadcrumb and the boot reconcile's second chance.
    return false;
  }
}

function restoreMode(path: string, mode: number | undefined): void {
  if (mode !== undefined) {
    chmodSync(path, mode);
  }
}
