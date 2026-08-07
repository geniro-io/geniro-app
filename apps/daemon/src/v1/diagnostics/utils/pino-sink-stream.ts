import { Writable } from 'node:stream';

import type { DebugLevel } from '../diagnostics.types';
import { debugSink } from './debug-sink';

/**
 * pino's numeric levels → the names the debug log uses.
 *
 * `system` is the vendored logger's own custom level (99). It is not a
 * severity anyone filters by, so it lands as `info` rather than earning a
 * fifth name in the panel's filter row.
 */
const LEVEL_BY_NUMBER: Record<number, DebugLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'error',
  99: 'info',
};

/**
 * Fields pino puts on every line that describe the LOGGER rather than the
 * event. Kept out of the entry's context, where they would be four identical
 * columns on every row.
 */
const ENVELOPE_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'name',
  'msg',
  'appName',
  'appVersion',
  'environment',
  'instanceIp',
]);

/** Longest a single context value may be before it is elided. */
const MAX_CONTEXT_VALUE = 300;

/**
 * A pino destination that feeds every line into {@link debugSink}.
 *
 * It parses pino's own JSON rather than hooking the logger's methods, and that
 * is deliberate: `BaseLogger` composes the payload (custom fields, request
 * context, the error's stack) on its way to pino, so anything reading earlier
 * would record a different, poorer line than the one pino actually emits. The
 * cost is one JSON round-trip per line, on a logger that already serialises.
 *
 * Never throws. It sits inside the logging path, so a malformed line has to
 * degrade to "log the raw text" rather than take down the caller that was only
 * trying to say something.
 */
export function createPinoSinkStream(): Writable {
  return new Writable({
    // pino hands complete newline-terminated lines, but a chunk boundary is
    // the stream's to choose, so lines are re-split rather than assumed.
    write(chunk: Buffer | string, _encoding, callback) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) {
          recordLine(line);
        }
      }
      callback();
    },
  });
}

function recordLine(line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON — a pretty-printed line under `PRETTY_LOGS`, or something that
    // wrote to the same destination. Still worth having, verbatim.
    debugSink.record('daemon', 'info', line, null);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    debugSink.record('daemon', 'info', line, null);
    return;
  }
  const record = parsed as Record<string, unknown>;
  const level =
    LEVEL_BY_NUMBER[typeof record.level === 'number' ? record.level : 30] ??
    'info';
  const message =
    typeof record.msg === 'string' && record.msg.length > 0 ? record.msg : line;
  debugSink.record('daemon', level, message, contextOf(record));
}

function contextOf(
  record: Record<string, unknown>,
): Record<string, string> | null {
  const context: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ENVELOPE_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }
    const text = typeof value === 'string' ? value : safeJson(value);
    if (text.length === 0) {
      continue;
    }
    context[key] =
      text.length > MAX_CONTEXT_VALUE
        ? `${text.slice(0, MAX_CONTEXT_VALUE)}…`
        : text;
  }
  return Object.keys(context).length > 0 ? context : null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
