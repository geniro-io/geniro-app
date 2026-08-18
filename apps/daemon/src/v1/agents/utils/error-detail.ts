import type { AgentErrorDetail } from '../adapters/adapter.types';

/**
 * Build an {@link AgentErrorDetail} from whatever a failure actually reported,
 * or `undefined` when it reported nothing.
 *
 * Every caller has the same shape of problem — a handful of optional readings,
 * most of them null on any given failure — and the same two rules about them: a
 * null field is DROPPED rather than carried as null, and an object with no
 * fields left is no object at all. Written once so a second adapter cannot
 * decide, say, to keep `httpStatus: null` and put an empty row in the reader's
 * table.
 *
 * Agent-agnostic by construction: it names no CLI and knows nothing about where
 * a field came from.
 */
export function errorDetail(fields: {
  code?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
  sessionId?: string | null;
  durationMs?: number | null;
  exitCode?: number | null;
  signal?: string | null;
}): AgentErrorDetail | undefined {
  const detail: AgentErrorDetail = {};
  if (fields.code) {
    detail.code = fields.code;
  }
  // `!= null`, not truthiness: a 0 exit code is a real reading, and so is a
  // 0ms duration. `httpStatus` is the one where truthiness would silently be
  // right, and writing it differently from its neighbours is how the next
  // field gets it wrong.
  if (fields.httpStatus != null) {
    detail.httpStatus = fields.httpStatus;
  }
  if (fields.requestId) {
    detail.requestId = fields.requestId;
  }
  if (fields.sessionId) {
    detail.sessionId = fields.sessionId;
  }
  if (fields.durationMs != null) {
    detail.durationMs = fields.durationMs;
  }
  if (fields.exitCode != null) {
    detail.exitCode = fields.exitCode;
  }
  if (fields.signal) {
    detail.signal = fields.signal;
  }
  return Object.keys(detail).length === 0 ? undefined : detail;
}
