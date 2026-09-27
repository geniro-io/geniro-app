import type { ActiveSpan } from '../chat.types';
import { usageFiguresFromRaw } from './usage-figures';

/** One row of the projection {@link activeSpansFrom} folds. */
export interface SpanRow {
  kind: string;
  nodeId: string | null;
  createdAt: Date;
  /** The row's JSON text, exactly as stored. */
  payload: string;
}

/**
 * The wall-clock stretches in which SOME agent of a run was working, merged —
 * what the chat header's clock is drawn from on a WORKFLOW run.
 *
 * Why this exists rather than `ChatTotals.workedMs`: that figure is a SUM of
 * every turn's own duration, so two agents working a minute in parallel is two
 * minutes there. On a workflow that is the ordinary case — a Manager's turn
 * stays open for the whole time it waits in `await_agent` while its Engineer
 * works — and a clock built on the sum advanced two seconds a second. REPORTED
 * as exactly that ("the timer in the header grows by 2 seconds every second").
 * A clock is read as a clock, so its settled half is the UNION of these spans.
 *
 * A turn's span ends at its `turn_complete` row and reaches back by the CLI's
 * own `durationMs`. A CLI that reports no timing (cursor, over ACP) is measured
 * from the node's most recent `running` status row instead — the same reading
 * the renderer's own wall-clock fallback takes — so a cursor QA node's stretch
 * is not simply missing from the clock. A turn with neither is left out: a
 * stretch nothing measured is not invented.
 *
 * Rows must arrive in `seq` order.
 */
export function activeSpansFrom(rows: readonly SpanRow[]): ActiveSpan[] {
  const runningSince = new Map<string, number>();
  const spans: ActiveSpan[] = [];
  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (!Number.isFinite(at)) {
      continue;
    }
    const key = row.nodeId ?? '';
    if (row.kind === 'status') {
      const status = statusOf(row.payload);
      if (status === 'running' && !runningSince.has(key)) {
        runningSince.set(key, at);
      } else if (
        status === 'failed' ||
        status === 'cancelled' ||
        status === 'skipped'
      ) {
        // A turn that ended without a `turn_complete` must not lend its start
        // to the node's NEXT turn, or that one would be measured from here.
        runningSince.delete(key);
      }
      continue;
    }
    if (row.kind !== 'turn_complete') {
      continue;
    }
    const since = runningSince.get(key);
    runningSince.delete(key);
    const durationMs = usageFiguresFromRaw(row.payload)?.durationMs ?? null;
    const startMs =
      durationMs !== null && durationMs > 0
        ? at - durationMs
        : since !== undefined
          ? since
          : null;
    if (startMs === null || startMs >= at) {
      continue;
    }
    spans.push({ startMs, endMs: at });
  }
  return mergeSpans(spans);
}

/** Sort and coalesce overlapping (or touching) spans into disjoint ones. */
export function mergeSpans(spans: readonly ActiveSpan[]): ActiveSpan[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const merged: ActiveSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && span.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function statusOf(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { status?: unknown }).status
      : undefined;
  } catch {
    return undefined;
  }
}
