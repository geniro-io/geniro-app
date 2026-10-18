import { describe, expect, it } from 'vitest';

import type { TimelineSpans, ToolCallTime } from '../chat.types';
import { foldThreadTimeline, pairToolCalls } from './thread-timeline';

const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const s = (seconds: number): number => T0 + seconds * 1000;
const iso = (seconds: number): string => new Date(s(seconds)).toISOString();

function tool(
  seq: number,
  kind: ToolCallTime['kind'],
  toolId: string,
  seconds: number,
  nodeId: string | null = 'lead',
  name: string | null = 'Bash',
  isError = false,
): ToolCallTime {
  return {
    seq,
    kind,
    nodeId,
    inCall: null,
    at: s(seconds),
    toolId,
    name,
    isError,
  };
}

describe('pairToolCalls', () => {
  it('times each call to the result carrying its id, whatever order they finish in', () => {
    const spans = pairToolCalls(
      [
        tool(1, 'tool_call', 'a', 0),
        tool(2, 'tool_call', 'b', 1),
        tool(3, 'tool_result', 'b', 4),
        tool(4, 'tool_result', 'a', 10),
      ],
      s(10),
      false,
    );

    expect(
      spans.map((span) => [span.seq, span.resultSeq, span.durationMs]),
    ).toEqual([
      [1, 4, 10_000],
      [2, 3, 3_000],
    ]);
  });

  it('runs an unanswered call to the last row only while the run works', () => {
    const rows = [tool(1, 'tool_call', 'a', 0)];

    expect(pairToolCalls(rows, s(30), true)[0]).toMatchObject({
      durationMs: 30_000,
      open: true,
    });
    expect(pairToolCalls(rows, s(30), false)[0]).toMatchObject({
      durationMs: null,
      open: false,
    });
  });

  it('marks a call failed only when its own result came back as an error', () => {
    const spans = pairToolCalls(
      [
        tool(1, 'tool_call', 'a', 0),
        tool(2, 'tool_call', 'b', 1),
        tool(3, 'tool_result', 'b', 2, 'lead', null, true),
        tool(4, 'tool_result', 'a', 3),
      ],
      s(3),
      false,
    );

    expect(spans.map((span) => [span.seq, span.failed])).toEqual([
      [1, false],
      [2, true],
    ]);
  });
});

describe('foldThreadTimeline', () => {
  /**
   * lead works 0-10, calls two workers in parallel (10-40), and asks the user
   * a question 45-65 before finishing at 80. worker-a takes 10-25, worker-b
   * 10-38 — so b, not a, is on the critical path.
   */
  const spans: TimelineSpans = {
    from: s(0),
    to: s(80),
    turns: [
      { nodeId: 'lead', startedAt: iso(0), durationMs: 80_000 },
      { nodeId: 'worker-a', startedAt: iso(10), durationMs: 15_000 },
      { nodeId: 'worker-b', startedAt: iso(10), durationMs: 28_000 },
    ],
    calls: [
      {
        callerNodeId: 'lead',
        calleeNodeId: 'worker-a',
        mode: 'sync',
        startedAt: iso(10),
        durationMs: 16_000,
      },
      {
        callerNodeId: 'lead',
        calleeNodeId: 'worker-b',
        mode: 'sync',
        startedAt: iso(10),
        durationMs: 30_000,
      },
    ],
    waits: [{ nodeId: 'lead', startedAt: iso(45), durationMs: 20_000 }],
  };

  it("splits each node's turn time into its own work, callee waits and user waits", () => {
    const timeline = foldThreadTimeline(spans, []);
    const lead = timeline.nodes.find((node) => node.nodeId === 'lead');

    expect(lead).toMatchObject({
      inTurnsMs: 80_000,
      waitingOnCalleeMs: 30_000,
      waitingOnUserMs: 20_000,
      busyMs: 30_000,
    });
    expect(timeline.wallMs).toBe(80_000);
    expect(timeline.waitingOnUserMs).toBe(20_000);
  });

  it('puts the slower of two parallel calls on the critical path, and the user wait beside it', () => {
    const timeline = foldThreadTimeline(spans, []);

    expect(
      timeline.criticalPath.map((segment) => [
        segment.kind,
        segment.nodeId,
        segment.durationMs,
      ]),
    ).toEqual([
      ['work', 'lead', 10_000],
      ['work', 'worker-b', 28_000],
      ['idle', null, 2_000],
      ['work', 'lead', 5_000],
      ['waiting_on_user', null, 20_000],
      ['work', 'lead', 15_000],
    ]);
    expect(timeline.criticalPathMs).toBe(58_000);
    expect(timeline.sinks).toEqual([
      { nodeId: 'lead', ms: 30_000 },
      { nodeId: 'worker-b', ms: 28_000 },
    ]);
  });

  it('totals tool time per node and tool, longest first', () => {
    const timeline = foldThreadTimeline(
      spans,
      pairToolCalls(
        [
          tool(1, 'tool_call', 'a', 1, 'lead', 'Read'),
          tool(2, 'tool_result', 'a', 2, 'lead'),
          tool(3, 'tool_call', 'b', 11, 'worker-b', 'Bash'),
          tool(4, 'tool_result', 'b', 31, 'worker-b'),
          tool(5, 'tool_call', 'c', 32, 'worker-b', 'Bash'),
          tool(6, 'tool_result', 'c', 35, 'worker-b', null, true),
        ],
        s(80),
        false,
      ),
    );

    expect(timeline.toolTotals[0]).toEqual({
      nodeId: 'worker-b',
      name: 'Bash',
      calls: 2,
      totalMs: 23_000,
      maxMs: 20_000,
      failed: 1,
    });
    expect(
      timeline.nodes.find((node) => node.nodeId === 'worker-b'),
    ).toMatchObject({ toolCalls: 2, toolMs: 23_000 });
  });
});

describe('thread timeline edge cases', () => {
  it('holds a caller on a call recorded with no mode, and never on an async one', () => {
    // TWIN of the renderer's `blocksCaller`: an older build wrote no mode,
    // and both sides read that as a call the caller waited on.
    const timeline = foldThreadTimeline(
      {
        from: s(0),
        to: s(60),
        turns: [{ nodeId: 'lead', startedAt: iso(0), durationMs: 60_000 }],
        calls: [
          {
            callerNodeId: 'lead',
            calleeNodeId: 'worker',
            mode: null,
            startedAt: iso(10),
            durationMs: 20_000,
          },
          {
            callerNodeId: 'lead',
            calleeNodeId: 'other',
            mode: 'async',
            startedAt: iso(30),
            durationMs: 20_000,
          },
        ],
        waits: [],
      },
      [],
    );

    expect(
      timeline.nodes.find((node) => node.nodeId === 'lead')?.waitingOnCalleeMs,
    ).toBe(20_000);
  });

  it('never reports a critical path longer than the wall clock', () => {
    // The first turn reaches BACK from its turn_complete by the CLI's own
    // duration, so it can start before the run's first row.
    const timeline = foldThreadTimeline(
      {
        from: s(0),
        to: s(10),
        turns: [{ nodeId: null, startedAt: iso(-50), durationMs: 60_000 }],
        calls: [],
        waits: [],
      },
      [],
    );

    expect(timeline.criticalPathMs).toBe(10_000);
    expect(timeline.criticalPath[0]?.startMs).toBe(s(0));
  });

  it('pairs a tool id two nodes both used within each node only', () => {
    const spans = pairToolCalls(
      [
        tool(1, 'tool_call', 'call_1', 0, 'a'),
        tool(2, 'tool_call', 'call_1', 1, 'b'),
        tool(3, 'tool_result', 'call_1', 5, 'a'),
        tool(4, 'tool_result', 'call_1', 30, 'b'),
      ],
      s(30),
      false,
    );

    expect(spans.map((span) => [span.nodeId, span.durationMs])).toEqual([
      ['a', 5_000],
      ['b', 29_000],
    ]);
  });

  it('keeps work that runs past the cursor on the path instead of calling it idle', () => {
    // An async caller keeps working while its callee runs: the callee's turn
    // starts INSIDE the caller's, which ends later.
    const timeline = foldThreadTimeline(
      {
        from: s(0),
        to: s(100),
        turns: [
          { nodeId: 'lead', startedAt: iso(0), durationMs: 30_000 },
          { nodeId: 'worker', startedAt: iso(5), durationMs: 85_000 },
          { nodeId: 'lead', startedAt: iso(91), durationMs: 9_000 },
        ],
        calls: [
          {
            callerNodeId: 'lead',
            calleeNodeId: 'worker',
            mode: 'async',
            startedAt: iso(5),
            durationMs: 85_000,
          },
        ],
        waits: [],
      },
      [],
    );

    expect(
      timeline.criticalPath.map((segment) => [
        segment.kind,
        segment.nodeId,
        segment.durationMs,
      ]),
    ).toEqual([
      ['work', 'lead', 5_000],
      ['work', 'worker', 85_000],
      ['idle', null, 1_000],
      ['work', 'lead', 9_000],
    ]);
  });

  it('keeps a callee that settles just after its call result on the path', () => {
    const timeline = foldThreadTimeline(
      {
        from: s(0),
        to: s(80),
        turns: [
          { nodeId: 'lead', startedAt: iso(0), durationMs: 80_000 },
          { nodeId: 'worker', startedAt: iso(10), durationMs: 31_000 },
        ],
        calls: [
          {
            callerNodeId: 'lead',
            calleeNodeId: 'worker',
            mode: 'sync',
            startedAt: iso(10),
            durationMs: 30_000,
          },
        ],
        waits: [],
      },
      [],
    );

    expect(timeline.sinks.map((sink) => sink.nodeId)).toContain('worker');
    expect(
      timeline.criticalPath.filter((segment) => segment.kind === 'idle'),
    ).toEqual([]);
  });

  it('pairs a tool id one node reused in two calls within each call only', () => {
    const row = (
      seq: number,
      kind: ToolCallTime['kind'],
      inCall: string,
      seconds: number,
    ): ToolCallTime => ({
      ...tool(seq, kind, 'call_1', seconds, 'worker'),
      inCall,
    });
    const spans = pairToolCalls(
      [
        row(1, 'tool_call', 'call-1', 0),
        row(2, 'tool_call', 'call-2', 1),
        row(3, 'tool_result', 'call-1', 4),
        row(4, 'tool_result', 'call-2', 21),
      ],
      s(21),
      false,
    );

    expect(spans.map((span) => span.durationMs)).toEqual([4_000, 20_000]);
  });

  it('answers a reused id first-in, first-out when a second call opens before the first is answered', () => {
    const spans = pairToolCalls(
      [
        tool(1, 'tool_call', 'call_1', 0),
        tool(2, 'tool_call', 'call_1', 2),
        tool(3, 'tool_result', 'call_1', 5),
        tool(4, 'tool_result', 'call_1', 9),
      ],
      s(9),
      false,
    );

    expect(spans.map((span) => span.durationMs)).toEqual([5_000, 7_000]);
  });
});
