import { describe, expect, it } from 'vitest';

import {
  eventOfRow,
  newestFailedCalls,
  oneLine,
  timelineEvents,
} from './timeline-events';

function row(kind: string, payload: unknown, seq = 1) {
  return {
    id: `r${seq}`,
    seq,
    kind,
    memberId: 'm',
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    createdAt: new Date(Date.UTC(2026, 10, 20) + seq * 1000),
  };
}

describe('oneLine', () => {
  it('collapses whitespace onto one line', () => {
    expect(oneLine('  a\n\n b\tc ')).toBe('a b c');
  });

  it('cuts on code points, never splitting an emoji', () => {
    const long = '😀'.repeat(250);
    const cut = oneLine(long)!;
    expect([...cut]).toHaveLength(200);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it('answers null for nothing to say', () => {
    expect(oneLine('   ')).toBeNull();
    expect(oneLine(null)).toBeNull();
  });
});

describe('eventOfRow', () => {
  const none = new Set<string>();

  it('skips a stage nudge and a stall', () => {
    expect(
      eventOfRow(row('stage_change', { action: 'nudge' }), none),
    ).toBeNull();
    expect(
      eventOfRow(row('stage_change', { action: 'stalled' }), none),
    ).toBeNull();
  });

  it('names the agent that moved a stage, and nobody for the user or the daemon', () => {
    expect(
      eventOfRow(
        row('stage_change', {
          action: 'skip',
          stageTitle: 'Plan',
          by: { kind: 'agent', nodeId: 'lead' },
        }),
        none,
      ),
    ).toMatchObject({ kind: 'stage', memberId: 'lead', detail: 'skip' });
    expect(
      eventOfRow(
        row('stage_change', {
          action: 'reopen',
          stageTitle: 'Plan',
          by: { kind: 'user', via: 'desktop' },
        }),
        none,
      )?.memberId,
    ).toBeNull();
  });

  it('keeps a call result only when it failed, under the callee', () => {
    expect(
      eventOfRow(
        row('call_result', { status: 'ok', calleeNodeId: 'qa' }),
        none,
      ),
    ).toBeNull();
    expect(
      eventOfRow(
        row('call_result', {
          status: 'error',
          calleeNodeId: 'qa',
          error: 'boom\nstack',
        }),
        none,
      ),
    ).toMatchObject({ kind: 'failure', memberId: 'qa', text: 'boom' });
  });

  it('leaves out a report whose every finding carries what was done about it', () => {
    expect(
      eventOfRow(
        row('report_findings', {
          findings: [{ summary: 'x', outcome: 'fixed' }],
        }),
        none,
      ),
    ).toBeNull();
  });

  it('marks an approval open until a verdict or unanswerable row names it', () => {
    const request = row('approval_request', { id: 'a1', toolName: 'Bash' });
    expect(eventOfRow(request, none)?.open).toBe(true);
    expect(eventOfRow(request, new Set(['a1']))?.open).toBe(false);
  });

  it('answers null for a payload that does not parse', () => {
    expect(eventOfRow(row('milestone', '{ broken'), none)).toBeNull();
  });
});

describe('newestFailedCalls', () => {
  it('keeps the newest failed call results, oldest first, and nothing else', () => {
    const rows = [
      row('call_result', { status: 'error' }, 1),
      row('call_started', { status: 'error' }, 2),
      row('call_result', { status: 'ok' }, 3),
      row('call_result', { status: 'error' }, 4),
      row('call_result', { status: 'error' }, 5),
    ];
    expect(newestFailedCalls(rows, 2).map((r) => r.seq)).toEqual([4, 5]);
    expect(newestFailedCalls(rows, 10).map((r) => r.seq)).toEqual([1, 4, 5]);
  });
});

describe('timelineEvents', () => {
  it('places an achieved goal by when it closed, and leaves an open one out', () => {
    const { events } = timelineEvents({
      rows: [row('milestone', { text: 'step', kind: 'done', nodeId: 'm' }, 5)],
      answeredApprovals: new Set(),
      pullRequests: [],
      goals: [
        {
          number: 1,
          text: 'ship',
          status: 'achieved',
          closedAt: new Date(Date.UTC(2026, 10, 21)),
        },
        { number: 2, text: 'later', status: 'open', closedAt: null },
      ],
      started: null,
    });
    expect(events.map((e) => [e.kind, e.seq])).toEqual([
      ['goal', null],
      ['step', 5],
    ]);
  });
});
