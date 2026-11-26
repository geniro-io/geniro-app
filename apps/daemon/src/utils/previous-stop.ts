import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { redactSecrets } from '../v1/diagnostics/utils/redact';
import {
  DAEMON_EXIT_NOTE_NAME,
  DAEMON_HEARTBEAT_NAME,
  DAEMON_LAST_ERROR_NAME,
} from './handshake';
import { consumeStopCause, type InterruptCause } from './stop-cause';

export const HEARTBEAT_EVERY_MS = 30_000;

const ERROR_MESSAGE_MAX_LENGTH = 160;

export interface DaemonHeartbeat {
  pid: number;
  startedAt: number;
  at: number;
  rssBytes: number;
}

export interface DaemonExitNote {
  pid: number;
  code: number | null;
  signal: string | null;
  at: string;
  killedAfterMs: number | null;
}

export interface DaemonLastError {
  pid: number;
  name: string;
  message: string;
  where: string | null;
  at: number;
}

export interface PreviousStopRecords {
  heartbeat: DaemonHeartbeat | null;
  exit: DaemonExitNote | null;
  lastError: DaemonLastError | null;
}

export interface PreviousStop {
  cause: InterruptCause;
  detail: string | null;
}

export function writeHeartbeat(
  userDataDir: string,
  heartbeat: DaemonHeartbeat,
): void {
  const path = join(userDataDir, DAEMON_HEARTBEAT_NAME);
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, JSON.stringify(heartbeat), { mode: 0o600 });
  renameSync(staged, path);
}

/** Synchronous: it runs inside the uncaught-exception handler, before the self-SIGTERM. */
export function writeLastError(
  userDataDir: string,
  pid: number,
  err: unknown,
  at: number,
): void {
  const record: DaemonLastError = { pid, ...summarizeError(err), at };
  writeFileSync(
    join(userDataDir, DAEMON_LAST_ERROR_NAME),
    JSON.stringify(record),
    { mode: 0o600 },
  );
}

export function summarizeError(
  err: unknown,
): Pick<DaemonLastError, 'name' | 'message' | 'where'> {
  const declared =
    err instanceof Error
      ? err.name || err.constructor.name || 'Error'
      : typeof err;
  const name = errorName(declared);
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = redactSecrets(raw.split('\n')[0] ?? '').trim();
  const message =
    firstLine.length > ERROR_MESSAGE_MAX_LENGTH
      ? `${firstLine.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
      : firstLine;
  const where =
    err instanceof Error && typeof err.stack === 'string'
      ? topFrameSource(err.stack)
      : null;
  return { name, message, where };
}

function errorName(declared: string): string {
  return /^[A-Za-z0-9_$.]{1,80}$/.test(declared) ? declared : 'Error';
}

function topFrameSource(stack: string): string | null {
  for (const line of stack.split('\n').slice(1)) {
    const path = /(?:\(|at )((?:file:\/\/)?\/[^():]+):\d+:\d+\)?\s*$/.exec(
      line.trim(),
    )?.[1];
    if (path !== undefined) {
      return basename(path).replace(/\.[cm]?[jt]s$/, '');
    }
  }
  return null;
}

export function consumePreviousStopRecords(
  userDataDir: string,
): PreviousStopRecords {
  const heartbeat = consumeJson(
    join(userDataDir, DAEMON_HEARTBEAT_NAME),
    parseHeartbeat,
  );
  const exit = consumeExitNote(userDataDir);
  const lastError = consumeJson(
    join(userDataDir, DAEMON_LAST_ERROR_NAME),
    parseLastError,
  );
  const pid = heartbeat?.pid ?? lastError?.pid ?? exit?.pid ?? null;
  return {
    heartbeat,
    exit: exit !== null && exit.pid === pid ? exit : null,
    lastError: lastError !== null && lastError.pid === pid ? lastError : null,
  };
}

export function consumeExitNote(userDataDir: string): DaemonExitNote | null {
  return consumeJson(join(userDataDir, DAEMON_EXIT_NOTE_NAME), parseExitNote);
}

/**
 * Why the previous daemon stopped: the UI's word for it, and — when that word
 * is `crash` or `unknown` — what the records it left say about how it ended.
 * Every record is removed as it is read, so it describes one stop only.
 */
export function readPreviousStop(
  userDataDir: string,
  macBootedAt: number,
): PreviousStop {
  const cause = consumeStopCause(userDataDir);
  const records = consumePreviousStopRecords(userDataDir);
  const announced = cause !== 'crash' && cause !== 'unknown';
  return {
    cause,
    detail:
      !announced ||
      (records.exit !== null && records.exit.killedAfterMs !== null)
        ? composeStopDetail(records, macBootedAt)
        : null,
  };
}

export function composeStopDetail(
  { heartbeat, exit, lastError }: PreviousStopRecords,
  macBootedAt: number,
): string | null {
  const memory =
    heartbeat !== null ? `memory ${formatMemory(heartbeat.rssBytes)}` : null;
  if (lastError !== null) {
    const where = lastError.where !== null ? ` in ${lastError.where}` : '';
    const message = lastError.message !== '' ? `: ${lastError.message}` : '';
    return `uncaught ${lastError.name}${where}${message}`;
  }
  if (exit !== null && exit.killedAfterMs !== null) {
    return withNote(
      `killed by Geniro after it did not stop within ${Math.round(exit.killedAfterMs / 1000)} s`,
      memory,
    );
  }
  if (exit !== null && exit.signal !== null) {
    return withNote(`killed by ${exit.signal}`, memory);
  }
  if (exit !== null && exit.code !== null) {
    return withNote(
      exit.code === 0 ? 'exited on its own' : `exited with code ${exit.code}`,
      memory,
    );
  }
  if (heartbeat === null) {
    return null;
  }
  const seen = `last heartbeat ${isoSecond(heartbeat.at)}, ${memory}`;
  return heartbeat.at < macBootedAt
    ? `the Mac shut down or restarted; ${seen}`
    : `no exit was recorded; ${seen}`;
}

export function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1
    ? `${gb.toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function withNote(text: string, note: string | null): string {
  return note === null ? text : `${text} (${note})`;
}

function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function consumeJson<T>(
  path: string,
  parse: (raw: unknown) => T | null,
): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  rmSync(path, { force: true });
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseHeartbeat(raw: unknown): DaemonHeartbeat | null {
  if (
    !isRecord(raw) ||
    !isPid(raw.pid) ||
    !isFiniteNumber(raw.startedAt) ||
    !isFiniteNumber(raw.at) ||
    !isFiniteNumber(raw.rssBytes)
  ) {
    return null;
  }
  return {
    pid: raw.pid,
    startedAt: raw.startedAt,
    at: raw.at,
    rssBytes: raw.rssBytes,
  };
}

function parseExitNote(raw: unknown): DaemonExitNote | null {
  if (!isRecord(raw) || !isPid(raw.pid) || typeof raw.at !== 'string') {
    return null;
  }
  const code =
    typeof raw.code === 'number' && Number.isInteger(raw.code)
      ? raw.code
      : null;
  const signal =
    typeof raw.signal === 'string' && /^SIG[A-Z0-9]+$/.test(raw.signal)
      ? raw.signal
      : null;
  const killedAfterMs =
    typeof raw.killedAfterMs === 'number' &&
    Number.isFinite(raw.killedAfterMs) &&
    raw.killedAfterMs >= 0
      ? raw.killedAfterMs
      : null;
  return { pid: raw.pid, code, signal, at: raw.at, killedAfterMs };
}

function parseLastError(raw: unknown): DaemonLastError | null {
  if (
    !isRecord(raw) ||
    !isPid(raw.pid) ||
    typeof raw.name !== 'string' ||
    typeof raw.message !== 'string' ||
    !isFiniteNumber(raw.at)
  ) {
    return null;
  }
  return {
    pid: raw.pid,
    name: errorName(raw.name),
    message: raw.message.slice(0, ERROR_MESSAGE_MAX_LENGTH),
    where: typeof raw.where === 'string' ? raw.where.slice(0, 120) : null,
    at: raw.at,
  };
}
