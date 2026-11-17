import type { ActiveSpan } from '../../agents/chat.types';
import {
  activeSpansFrom,
  pausedSpansFrom,
  type SpanRow,
} from '../../agents/utils/active-spans';
import {
  asRecord,
  asString,
  parseJsonColumn,
  payloadString,
} from '../../agents/utils/json-util';
import { messageText } from '../../agents/utils/message-preview';
import {
  STRIP_MAX_MARKERS,
  type StripMarker,
  type StripMarkerKind,
  type StripSpan,
  type ThreadStrip,
} from '../command-center.types';

const LABEL_MAX = 80;

/** One transcript row the strip reads, in seq order. */
export interface StripRow extends SpanRow {
  role: string | null;
}

/** Everything one card's strip is folded from. */
export interface StripInput {
  rows: readonly StripRow[];
  /** The strip's left edge and right edge (now), epoch ms. */
  start: number;
  now: number;
  /** The run's live state, for a stretch that opened before the rows read. */
  running: boolean;
  awaiting: boolean;
  /** Pull requests the run opened, placed in time already. */
  pullRequests: readonly { at: number; label: string }[];
  /** Messages between the thread and the manager. */
  mail: readonly { at: number; direction: 'out' | 'in' }[];
}

function oneLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') {
    return null;
  }
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** `spans` cut to `[start, now]`; a span running to infinity stays open. */
function clipped(
  spans: readonly ActiveSpan[],
  kind: StripSpan['kind'],
  start: number,
  now: number,
): StripSpan[] {
  return spans.flatMap((span) => {
    const open = !Number.isFinite(span.endMs) || span.endMs > now;
    const from = Math.max(span.startMs, start);
    const to = open ? now : span.endMs;
    if (to <= start || from >= now || from >= to) {
      return [];
    }
    return [{ kind, start: iso(from), end: open ? null : iso(to) }];
  });
}

/** Where the turn still running at the last row began, or null when none is. */
function openTurnStart(rows: readonly StripRow[]): number | null {
  let since: number | null = null;
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (row.kind === 'turn_complete') {
      since = null;
      continue;
    }
    if (row.kind !== 'status' || row.memberId !== null) {
      continue;
    }
    const body = asRecord(parseJsonColumn(row.payload));
    if (body?.status === 'running' && body.offTurn !== true) {
      since ??= at;
    } else if (
      body?.status === 'completed' ||
      body?.status === 'failed' ||
      body?.status === 'cancelled'
    ) {
      since = null;
    }
  }
  return since;
}

function questionLabel(payload: string): string | null {
  const body = asRecord(parseJsonColumn(payload));
  const questions = Array.isArray(body?.questions) ? body.questions : [];
  const first = asRecord(questions[0]);
  return oneLine(asString(first?.question) ?? asString(first?.header));
}

function rowMarker(row: StripRow): StripMarker | null {
  const at = iso(row.createdAt.getTime());
  if (row.kind === 'message' && row.role === 'user' && row.memberId === null) {
    return {
      kind: 'user_message',
      at,
      label: oneLine(messageText(row.payload)),
    };
  }
  if (row.kind === 'approval_request') {
    const body = asRecord(parseJsonColumn(row.payload));
    return Array.isArray(body?.questions) && body.questions.length > 0
      ? { kind: 'question', at, label: questionLabel(row.payload) }
      : null;
  }
  if (row.kind === 'error') {
    return {
      kind: 'failure',
      at,
      label: oneLine(payloadString(parseJsonColumn(row.payload), 'message')),
    };
  }
  if (row.kind === 'stage_change') {
    return {
      kind: 'stage',
      at,
      label: oneLine(payloadString(parseJsonColumn(row.payload), 'stageTitle')),
    };
  }
  return null;
}

/**
 * One thread's timeline strip over `[start, now]`: when it worked, when it
 * waited on the user, and the moments worth a marker. Work and waiting come
 * from the same folds the chat's clock uses (`activeSpansFrom`,
 * `pausedSpansFrom`); a turn or a card already open before the first row read
 * runs from the strip's left edge, as the run's live state says.
 */
export function foldThreadStrip(input: StripInput): ThreadStrip {
  const { rows, start, now } = input;
  const paused = pausedSpansFrom(rows);
  const work = clipped(activeSpansFrom(rows, paused), 'work', start, now);
  const waiting = clipped(paused, 'waiting', start, now);
  if (input.awaiting && !waiting.some((span) => span.end === null)) {
    waiting.push({ kind: 'waiting', start: iso(start), end: null });
  }
  if (input.running) {
    const turnFrom = Math.max(start, openTurnStart(rows) ?? start);
    const openWait = waiting.find((span) => span.end === null);
    if (openWait === undefined) {
      work.push({ kind: 'work', start: iso(turnFrom), end: null });
    } else if (Date.parse(openWait.start) > turnFrom) {
      work.push({ kind: 'work', start: iso(turnFrom), end: openWait.start });
    }
  }
  const markers: StripMarker[] = [];
  for (const row of rows) {
    const marker = rowMarker(row);
    const at = row.createdAt.getTime();
    if (marker !== null && at >= start && at <= now) {
      markers.push(marker);
    }
  }
  const timed = (
    kind: StripMarkerKind,
    at: number,
    label: string | null,
  ): void => {
    if (at >= start && at <= now) {
      markers.push({ kind, at: iso(at), label });
    }
  };
  for (const pr of input.pullRequests) {
    timed('pr_opened', pr.at, pr.label);
  }
  for (const message of input.mail) {
    timed(
      message.direction === 'out' ? 'manager_out' : 'manager_in',
      message.at,
      null,
    );
  }
  markers.sort((a, b) => a.at.localeCompare(b.at));
  const spans = [...work, ...waiting].sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  return { spans, markers: markers.slice(-STRIP_MAX_MARKERS) };
}
