import { stripVTControlCharacters } from 'node:util';

import { redactSecrets } from '../../diagnostics/utils/redact';
import type { MonitorBatch } from '../chat.types';

/** How long output gathers before it is handed on as one batch. */
export const MONITOR_BATCH_WINDOW_MS = 200;
/** The most lines one message to the agent carries. */
export const MONITOR_EVENT_MAX_LINES = 100;
/** The most bytes (UTF-8, newlines included) one message carries. */
export const MONITOR_EVENT_MAX_BYTES = 16 * 1024;
/** A longer line is cut here, the cut marked with how much was dropped. */
export const MONITOR_LINE_MAX_CHARS = 1000;
/** The span the flood limits below are counted over. */
export const MONITOR_FLOOD_WINDOW_MS = 10_000;
/** More lines than this inside one flood window stops the monitor. */
export const MONITOR_FLOOD_MAX_LINES = 1000;
/** More bytes than this inside one flood window stops the monitor. */
export const MONITOR_FLOOD_MAX_BYTES = 256 * 1024;

/**
 * How far past the cut a line is kept until it is masked, so a registered
 * secret straddling the cut is still masked before the cut is made.
 */
const REDACT_MARGIN_CHARS = 256;

/** The suffix a line cut at {@link MONITOR_LINE_MAX_CHARS} ends with. */
export function cutLineSuffix(dropped: number): string {
  return ` … (+${dropped} characters)`;
}

/** The line closing a batch that had more than it could carry. */
export function omittedLinesNote(omitted: number): string {
  return `… ${omitted} more line${omitted === 1 ? '' : 's'} not delivered`;
}

function lineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8') + 1;
}

/**
 * Append `lines` to `batch` up to the per-message caps; what does not fit is
 * counted in `omitted`. Returns a new batch.
 *
 * Also how a held message absorbs the next one: a monitor whose agent is busy
 * keeps ONE pending message, and every later batch merges into it here.
 */
export function mergeMonitorBatch(
  batch: MonitorBatch,
  next: MonitorBatch,
): MonitorBatch {
  const lines = [...batch.lines];
  let bytes = lines.reduce((sum, line) => sum + lineBytes(line), 0);
  let omitted = batch.omitted + next.omitted;
  // Once a line is dropped nothing after it is kept: the agent reads a prefix
  // of the output and a count, never output with a hole in the middle.
  let full = batch.omitted > 0;
  for (const line of next.lines) {
    const size = lineBytes(line);
    full =
      full ||
      lines.length >= MONITOR_EVENT_MAX_LINES ||
      bytes + size > MONITOR_EVENT_MAX_BYTES;
    if (full) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    bytes += size;
  }
  return { lines, omitted };
}

/**
 * Turns a monitor's raw output into the batches its agent is sent — pure: the
 * caller owns the timer and calls {@link take} once per window.
 *
 * Output is split into lines across chunk boundaries, ANSI and other terminal
 * control sequences are stripped, a carriage-return redraw keeps only what a
 * terminal would show last, and a line longer than
 * {@link MONITOR_LINE_MAX_CHARS} is cut with the dropped length named.
 *
 * {@link push} answers `'flooded'` once the output inside the trailing
 * {@link MONITOR_FLOOD_WINDOW_MS} passes either flood limit; the caller stops
 * the monitor then, and what was gathered goes out with its end.
 */
export class MonitorBatcher {
  private pending: string[] = [];
  /** The unfinished last line, kept to the cap plus the masking margin. */
  private partial = '';
  /** Characters of the unfinished line past what is kept. */
  private partialDropped = 0;
  /** The last chunk ended in `\r`: a redraw, unless a `\n` comes next. */
  private pendingCr = false;
  private readonly recent: { at: number; lines: number; bytes: number }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** Take in one chunk of output. */
  push(chunk: string): 'ok' | 'flooded' {
    const parts = chunk.split('\n');
    let lines = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      const endsLine = index < parts.length - 1;
      if (this.pendingCr && part !== '') {
        // Text after a chunk-final `\r`: it was a redraw, not a CRLF.
        this.partial = '';
        this.partialDropped = 0;
      }
      if (part !== '' || endsLine) {
        this.pendingCr = false;
      }
      this.extendPartial(part, endsLine);
      if (endsLine) {
        this.pending.push(this.finishPartial());
        lines += 1;
      }
    }
    return this.recordFlood(lines, Buffer.byteLength(chunk, 'utf8'));
  }

  /**
   * The batch gathered since the last take, or null when there is none.
   * `final` also hands over an unfinished last line — the command has ended,
   * so no newline is coming.
   */
  take(final = false): MonitorBatch | null {
    if (final && (this.partial !== '' || this.partialDropped > 0)) {
      this.pending.push(this.finishPartial());
    }
    if (this.pending.length === 0) {
      return null;
    }
    const batch = mergeMonitorBatch(
      { lines: [], omitted: 0 },
      { lines: this.pending, omitted: 0 },
    );
    this.pending = [];
    return batch;
  }

  private extendPartial(text: string, endsLine: boolean): void {
    let piece = text;
    if (piece.endsWith('\r')) {
      // A CRLF ending when a `\n` follows; otherwise a redraw is coming.
      piece = piece.slice(0, -1);
      this.pendingCr = !endsLine;
    }
    // A redraw (`\r` without `\n`) replaces what the line showed so far.
    const redraw = piece.lastIndexOf('\r');
    if (redraw !== -1) {
      this.partial = '';
      this.partialDropped = 0;
      piece = piece.slice(redraw + 1);
    }
    const clean = stripVTControlCharacters(piece);
    const room =
      MONITOR_LINE_MAX_CHARS + REDACT_MARGIN_CHARS - this.partial.length;
    if (clean.length <= room) {
      this.partial += clean;
      return;
    }
    this.partial += clean.slice(0, Math.max(0, room));
    this.partialDropped += clean.length - Math.max(0, room);
  }

  private finishPartial(): string {
    const masked = redactSecrets(this.partial);
    const dropped =
      this.partialDropped + Math.max(0, masked.length - MONITOR_LINE_MAX_CHARS);
    const line =
      dropped > 0
        ? masked.slice(0, MONITOR_LINE_MAX_CHARS) + cutLineSuffix(dropped)
        : masked;
    this.partial = '';
    this.partialDropped = 0;
    this.pendingCr = false;
    return line;
  }

  private recordFlood(lines: number, bytes: number): 'ok' | 'flooded' {
    const at = this.now();
    this.recent.push({ at, lines, bytes });
    while (
      this.recent.length > 0 &&
      at - (this.recent[0]?.at ?? at) > MONITOR_FLOOD_WINDOW_MS
    ) {
      this.recent.shift();
    }
    let lineTotal = 0;
    let byteTotal = 0;
    for (const entry of this.recent) {
      lineTotal += entry.lines;
      byteTotal += entry.bytes;
    }
    return lineTotal > MONITOR_FLOOD_MAX_LINES ||
      byteTotal > MONITOR_FLOOD_MAX_BYTES
      ? 'flooded'
      : 'ok';
  }
}
