import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * The crash journal for `.cursor/mcp.json` merges: one entry per live merge,
 * written BEFORE the user's file is touched and removed after restore. The
 * daemon-boot reconcile replays whatever is left, so a SIGKILL inside the 2s
 * grace window (spawn-cli's group-kill escalation) can strand a merge for at
 * most one daemon restart. Deterministic by construction — no disk scanning,
 * the journal names every cwd that may hold a stranded entry.
 *
 * Plain synchronous JSON: entries are added/removed one at a time under the
 * per-cwd mutex, so the file never has concurrent writers.
 */

export interface CursorMergeJournalEntry {
  cwd: string;
  /** Mirror of the merge state — restore may delete a file geniro created. */
  created: boolean;
  /** Original file mode to restore (merged-into-existing files only). */
  mode?: number;
  ts: number;
}

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

function parseJournal(path: string): CursorMergeJournalEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isJournalEntry)) {
      return null;
    }
    return parsed;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

export function readJournal(path: string): CursorMergeJournalEntry[] {
  return parseJournal(path) ?? [];
}

function journalEntriesForMutation(path: string): CursorMergeJournalEntry[] {
  const entries = parseJournal(path);
  if (entries === null) {
    throw new Error(`cursor MCP journal ${path} is malformed`);
  }
  return entries;
}

export function addJournalEntry(
  path: string,
  entry: CursorMergeJournalEntry,
): void {
  const entries = journalEntriesForMutation(path).filter(
    (e) => e.cwd !== entry.cwd,
  );
  entries.push(entry);
  writeJournal(path, entries);
}

export function removeJournalEntry(path: string, cwd: string): void {
  const entries = journalEntriesForMutation(path).filter((e) => e.cwd !== cwd);
  if (entries.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeJournal(path, entries);
}

function writeJournal(path: string, entries: CursorMergeJournalEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(entries), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  renameSync(tmp, path);
}
