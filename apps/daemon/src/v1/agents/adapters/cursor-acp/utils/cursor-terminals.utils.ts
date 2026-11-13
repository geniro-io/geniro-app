import { open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CommandRecord } from '../../adapter.types';
import { CURSOR_DATA_DIR_ENV } from '../cursor-acp.const';

const TERMINALS_DIR = 'terminals';
const TERMINAL_FILE_SUFFIX = '.txt';
const HEADER_FENCE = '---';
const MAX_HEADER_BYTES = 256 * 1024;
const MAX_FOOTER_BYTES = 4 * 1024;

/** Twin of the CLI's own `workspace-paths` rule (`index.js`, 2026.11.05-86047df). */
export function cursorProjectSlug(cwd: string): string {
  return cwd
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The first fenced block of a terminal file, or null for any other shape. */
export function parseCursorTerminalHeader(text: string): CommandRecord | null {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== HEADER_FENCE) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1)) {
    if (line.trim() === HEADER_FENCE) {
      return recordFrom(fields);
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
  }
  return null;
}

/**
 * The last fenced block of an ended terminal file — `exit_code`, `ended_at` —
 * which the CLI appends after the output; nulls for any other shape.
 */
export function parseCursorTerminalFooter(text: string): {
  exitCode: number | null;
  endedAt: string | null;
} {
  const lines = text.trimEnd().split('\n');
  if (lines.at(-1)?.trim() !== HEADER_FENCE) {
    return { exitCode: null, endedAt: null };
  }
  const fields = new Map<string, string>();
  for (let i = lines.length - 2; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.trim() === HEADER_FENCE) {
      break;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
    }
  }
  const exit = fields.get('exit_code');
  const exitCode = exit === undefined || exit === '' ? NaN : Number(exit);
  return {
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    endedAt: fields.get('ended_at') || null,
  };
}

function recordFrom(fields: Map<string, string>): CommandRecord | null {
  const pid = Number(fields.get('pid'));
  const command = quotedValue(fields.get('command'));
  const status = fields.get('status');
  if (!Number.isInteger(pid) || pid <= 0 || command === null || !status) {
    return null;
  }
  return { pid, command, running: status === 'running' };
}

function quotedValue(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** Where the CLI keeps the terminal records of commands run from `cwd`. */
export async function cursorTerminalDirs(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const dataDir =
    env[CURSOR_DATA_DIR_ENV]?.trim() || join(homedir(), '.cursor');
  const real = await realpath(cwd).catch(() => cwd);
  const slugs = new Set([cursorProjectSlug(real), cursorProjectSlug(cwd)]);
  return [...slugs].map((slug) =>
    join(dataDir, 'projects', slug, TERMINALS_DIR),
  );
}

/** What a terminal file held when last read, kept by its path. */
export type CursorTerminalCache = Map<
  string,
  { mtimeMs: number; record: CommandRecord | null }
>;

/**
 * The records written since `sinceMs`. A file another CLI process wrote reads
 * as a record too: the caller decides by whether its pid runs under this CLI.
 * Only a file that moved is read again, as a long session leaves hundreds.
 */
export async function readCursorTerminalRecords(
  dirs: readonly string[],
  sinceMs: number,
  cache: CursorTerminalCache = new Map(),
): Promise<CommandRecord[]> {
  const records: CommandRecord[] = [];
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith(TERMINAL_FILE_SUFFIX)) {
        continue;
      }
      const record = await readRecord(join(dir, name), sinceMs, cache);
      if (record !== null) {
        records.push(record);
      }
    }
  }
  return records;
}

async function readRecord(
  path: string,
  sinceMs: number,
  cache: CursorTerminalCache,
): Promise<CommandRecord | null> {
  try {
    const { mtimeMs } = await stat(path);
    if (mtimeMs < sinceMs) {
      return null;
    }
    const known = cache.get(path);
    if (known?.mtimeMs === mtimeMs) {
      return known.record;
    }
    const file = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(MAX_HEADER_BYTES);
      const { bytesRead } = await file.read(buffer, 0, MAX_HEADER_BYTES, 0);
      const header = parseCursorTerminalHeader(
        buffer.subarray(0, bytesRead).toString('utf8'),
      );
      let record: CommandRecord | null = null;
      if (header !== null) {
        record = { ...header, outputPath: path };
        if (!header.running) {
          const { size } = await file.stat();
          const start = Math.max(0, size - MAX_FOOTER_BYTES);
          const tail = Buffer.alloc(size - start);
          const read = await file.read(tail, 0, tail.length, start);
          const footer = parseCursorTerminalFooter(
            tail.subarray(0, read.bytesRead).toString('utf8'),
          );
          record = { ...record, ...footer };
        }
      }
      cache.set(path, { mtimeMs, record });
      return record;
    } finally {
      await file.close();
    }
  } catch {
    // The CLI prunes these files; one gone mid-read is simply not a record.
    cache.delete(path);
    return null;
  }
}
