/**
 * One comment as a review message carried it, read off a user message row.
 *
 * TWIN PARSER: mirrors the daemon's `ReviewSnapshot` / `ReviewPayload`
 * (`apps/daemon/src/v1/agents/chat.types.ts`), written on the row as
 * `payload.review`. Change one and change the other.
 */
export interface ReviewSnapshotView {
  number: number;
  folder: string;
  path: string;
  side: 'new' | 'old' | 'file';
  startLine: number | null;
  endLine: number | null;
  quote: string;
  body: string;
}

export interface ReviewPayloadView {
  note: string | null;
  comments: ReviewSnapshotView[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineOrNull(value: unknown): number | null | undefined {
  return value === null ? null : typeof value === 'number' ? value : undefined;
}

function readSnapshot(value: unknown): ReviewSnapshotView | null {
  if (!isRecord(value)) {
    return null;
  }
  const { number, folder, path, side, startLine, endLine, quote, body } = value;
  const start = lineOrNull(startLine);
  const end = lineOrNull(endLine);
  if (
    typeof number !== 'number' ||
    typeof folder !== 'string' ||
    typeof path !== 'string' ||
    (side !== 'new' && side !== 'old' && side !== 'file') ||
    start === undefined ||
    end === undefined ||
    typeof quote !== 'string' ||
    typeof body !== 'string'
  ) {
    return null;
  }
  return {
    number,
    folder,
    path,
    side,
    startLine: start,
    endLine: end,
    quote,
    body,
  };
}

/** The review a user message sent, or null when the row is an ordinary message. */
export function readReviewPayload(payload: unknown): ReviewPayloadView | null {
  if (!isRecord(payload) || !isRecord(payload.review)) {
    return null;
  }
  const { note, comments } = payload.review;
  if ((note !== null && typeof note !== 'string') || !Array.isArray(comments)) {
    return null;
  }
  const read = comments.map(readSnapshot);
  return read.every((comment) => comment !== null)
    ? { note, comments: read }
    : null;
}
