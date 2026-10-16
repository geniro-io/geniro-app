/**
 * Where a thread's time went, folded from rows geniro already stores: per-node
 * busy and waiting time, each tool call's duration, and the critical path.
 *
 * Pure over the waterfall's own spans (`ChatWaterfallService.fold`) plus the
 * id-only tool rows (`ItemDao.toolCallTimes`), so the analysis tools and the
 * waterfall card can never disagree about the same turns.
 */

import type {
  CriticalSegment,
  NodeTime,
  ThreadTimeline,
  TimelineSpans,
  ToolCallTime,
  ToolSpan,
  ToolTotal,
} from '../chat.types';

type Interval = readonly [number, number];

/** The intervals merged into disjoint, sorted ones. */
function merge(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

function length(intervals: readonly Interval[]): number {
  return merge(intervals).reduce((sum, [start, end]) => sum + end - start, 0);
}

/** `base` minus everything `cut` covers. Both are merged first. */
function subtract(
  base: readonly Interval[],
  cut: readonly Interval[],
): Interval[] {
  const holes = merge(cut);
  const out: Interval[] = [];
  for (const [start, end] of merge(base)) {
    let cursor = start;
    for (const [holeStart, holeEnd] of holes) {
      if (holeEnd <= cursor || holeStart >= end) {
        continue;
      }
      if (holeStart > cursor) {
        out.push([cursor, holeStart]);
      }
      cursor = Math.max(cursor, holeEnd);
    }
    if (cursor < end) {
      out.push([cursor, end]);
    }
  }
  return out;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return subtract(a, subtract(a, b));
}

/**
 * Pair each tool call with the result carrying its id.
 *
 * The first result after a call answers it; a later duplicate is ignored. A
 * call never answered is open while the run works (drawn to `to`) and has no
 * duration once it settled — a record that lost its ending, not a long call.
 */
export function pairToolCalls(
  rows: readonly ToolCallTime[],
  to: number,
  working: boolean,
): ToolSpan[] {
  // Ids are unique per CONVERSATION, not per run: an ACP CLI numbers its
  // calls from one in every session, so two nodes routinely reuse an id.
  const keyOf = (row: ToolCallTime): string =>
    `${row.nodeId ?? ''}\u0000${row.inCall ?? ''}\u0000${row.toolId ?? ''}`;
  // A queue per key: a CLI can open a second call under a reused id before the
  // first is answered, and the first result answers the first call.
  const open = new Map<string, ToolCallTime[]>();
  const spans: ToolSpan[] = [];
  const bySeq = new Map<number, ToolSpan>();
  for (const row of rows) {
    if (row.toolId === null) {
      continue;
    }
    if (row.kind === 'tool_call') {
      open.set(keyOf(row), [...(open.get(keyOf(row)) ?? []), row]);
      const entry: ToolSpan = {
        seq: row.seq,
        resultSeq: null,
        nodeId: row.nodeId,
        name: row.name ?? 'unknown',
        startMs: row.at,
        durationMs: null,
        open: false,
        delegate: row.delegate,
        failed: false,
      };
      spans.push(entry);
      bySeq.set(row.seq, entry);
      continue;
    }
    const queue = open.get(keyOf(row));
    const call = queue?.shift();
    if (call === undefined) {
      continue;
    }
    const entry = bySeq.get(call.seq)!;
    entry.resultSeq = row.seq;
    entry.durationMs = Math.max(0, row.at - call.at);
    entry.failed = row.isError;
  }
  if (working) {
    for (const call of [...open.values()].flat()) {
      const entry = bySeq.get(call.seq)!;
      entry.open = true;
      entry.durationMs = Math.max(0, to - call.at);
    }
  }
  return spans;
}

/**
 * Walk back from the end of the run, each time taking the work that was still
 * going latest before the cursor — the "last finisher" chain. An interval that
 * runs PAST the cursor counts up to the cursor: it was busy right then, and
 * dropping it would report its stretch as idle. A stretch nothing on the chain
 * covers is a wait on the user when a card was open, else idle.
 *
 * Parallel work that finished earlier than its sibling is, by construction,
 * off the path: shortening it would not have ended the run any sooner.
 */
function criticalPath(
  work: readonly { nodeId: string | null; interval: Interval }[],
  userWaits: readonly Interval[],
  from: number,
  to: number,
): CriticalSegment[] {
  const out: CriticalSegment[] = [];
  const gap = (start: number, end: number): void => {
    if (end <= start) {
      return;
    }
    const waited = intersect([[start, end]], userWaits);
    let cursor = start;
    for (const [waitStart, waitEnd] of waited) {
      if (waitStart > cursor) {
        out.push({
          kind: 'idle',
          nodeId: null,
          startMs: cursor,
          durationMs: waitStart - cursor,
        });
      }
      out.push({
        kind: 'waiting_on_user',
        nodeId: null,
        startMs: waitStart,
        durationMs: waitEnd - waitStart,
      });
      cursor = waitEnd;
    }
    if (cursor < end) {
      out.push({
        kind: 'idle',
        nodeId: null,
        startMs: cursor,
        durationMs: end - cursor,
      });
    }
  };
  let remaining = work.filter(({ interval }) => interval[1] > interval[0]);
  let cursor = to;
  while (cursor > from) {
    let best: { nodeId: string | null; interval: Interval } | null = null;
    let bestEnd = Number.NEGATIVE_INFINITY;
    for (const candidate of remaining) {
      const [start, end] = candidate.interval;
      if (start >= cursor) {
        continue;
      }
      const reach = Math.min(end, cursor);
      if (
        reach > bestEnd ||
        (reach === bestEnd && best !== null && start < best.interval[0])
      ) {
        best = candidate;
        bestEnd = reach;
      }
    }
    if (best === null) {
      gap(from, cursor);
      break;
    }
    gap(bestEnd, cursor);
    out.push({
      kind: 'work',
      nodeId: best.nodeId,
      startMs: best.interval[0],
      durationMs: bestEnd - best.interval[0],
    });
    cursor = best.interval[0];
    remaining = remaining.filter(({ interval }) => interval[0] < cursor);
  }
  return out.reverse();
}

/** How many of the largest critical-path holders a summary names. */
const SINK_COUNT = 3;

export function foldThreadTimeline(
  spans: TimelineSpans,
  tools: readonly ToolSpan[],
): ThreadTimeline {
  const nodeIds = new Set<string | null>();
  for (const turn of spans.turns) {
    nodeIds.add(turn.nodeId);
  }
  for (const tool of tools) {
    nodeIds.add(tool.nodeId);
  }

  // Every span is clipped to the read: a turn reaches BACK from its
  // turn_complete by the CLI's own duration, so the first one can start
  // before the run's first row, and nothing may outlast the last.
  const span = (startedAt: string, durationMs: number): Interval => {
    const start = Date.parse(startedAt);
    return [
      Math.max(spans.from, start),
      Math.min(spans.to, Math.max(spans.from, start + durationMs)),
    ];
  };
  const allUserWaits = spans.waits.map((wait) =>
    span(wait.startedAt, wait.durationMs),
  );
  const work: { nodeId: string | null; interval: Interval }[] = [];
  const busyAll: Interval[] = [];
  const nodes: NodeTime[] = [...nodeIds].map((nodeId) => {
    const turns = spans.turns
      .filter((turn) => turn.nodeId === nodeId)
      .map((turn) => span(turn.startedAt, turn.durationMs));
    const calleeWaits = spans.calls
      .filter((call) => call.callerNodeId === nodeId && call.mode !== 'async')
      .map((call) => span(call.startedAt, call.durationMs));
    const userWaits = spans.waits
      .filter((wait) => wait.nodeId === nodeId)
      .map((wait) => span(wait.startedAt, wait.durationMs));
    const onCallee = intersect(turns, calleeWaits);
    const onUser = subtract(intersect(turns, userWaits), onCallee);
    const busy = subtract(turns, [...calleeWaits, ...userWaits]);
    for (const interval of busy) {
      work.push({ nodeId, interval });
      busyAll.push(interval);
    }
    const lane = tools.filter((tool) => tool.nodeId === nodeId);
    const own = lane.filter((tool) => !tool.delegate);
    return {
      nodeId,
      inTurnsMs: length(turns),
      waitingOnCalleeMs: length(onCallee),
      waitingOnUserMs: length(onUser),
      busyMs: length(busy),
      turns: turns.length,
      toolCalls: own.length,
      delegateToolCalls: lane.length - own.length,
      toolMs: own.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0),
      delegateToolMs: lane
        .filter((tool) => tool.delegate)
        .reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0),
    };
  });

  const path = criticalPath(work, allUserWaits, spans.from, spans.to);
  const byNode = new Map<string | null, number>();
  for (const segment of path) {
    if (segment.kind === 'work') {
      byNode.set(
        segment.nodeId,
        (byNode.get(segment.nodeId) ?? 0) + segment.durationMs,
      );
    }
  }

  const totals = new Map<string, ToolTotal>();
  for (const tool of tools) {
    // Own and sub-agents' calls are separate rows, so each row's time is its count's.
    const key = `${tool.nodeId ?? ''}\u0000${tool.name}\u0000${tool.delegate}`;
    const total = totals.get(key) ?? {
      nodeId: tool.nodeId,
      name: tool.name,
      delegate: tool.delegate,
      calls: 0,
      totalMs: 0,
      maxMs: 0,
      failed: 0,
    };
    total.calls += 1;
    total.failed += tool.failed ? 1 : 0;
    total.totalMs += tool.durationMs ?? 0;
    total.maxMs = Math.max(total.maxMs, tool.durationMs ?? 0);
    totals.set(key, total);
  }

  return {
    from: spans.from,
    to: spans.to,
    wallMs: Math.max(0, spans.to - spans.from),
    activeMs: length(busyAll),
    waitingOnUserMs: length(allUserWaits),
    criticalPathMs: [...byNode.values()].reduce((sum, ms) => sum + ms, 0),
    criticalPath: path,
    sinks: [...byNode.entries()]
      .map(([nodeId, ms]) => ({ nodeId, ms }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, SINK_COUNT),
    nodes: nodes.sort((a, b) => b.inTurnsMs - a.inTurnsMs),
    tools: [...tools],
    toolTotals: [...totals.values()].sort((a, b) => b.totalMs - a.totalMs),
  };
}
