import { describe, expect, it } from 'vitest';

import type { ItemKind } from '../../runs/runs.types';
import type { ItemWire } from '../chat.types';
import {
  anchorNeedsOf,
  conversationCallIds,
  pageBoundsOf,
  workflowEdgeRows,
} from './history-anchors';

function row(seq: number, kind: ItemKind, payload: unknown): ItemWire {
  return {
    id: `i${seq}`,
    runId: 'run',
    nodeId: null,
    seq,
    kind,
    role: null,
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}

describe('anchorNeedsOf', () => {
  it('collects the calls a page names, including the thread a continuation continues', () => {
    const needs = anchorNeedsOf([
      row(10, 'status', { callId: 'call-3', status: 'running' }),
      row(11, 'call_started', { callId: 'call-9', thread: 'call-4' }),
    ]);
    expect([...needs.callIds].sort()).toEqual(['call-3', 'call-4', 'call-9']);
  });

  it('asks for the call of a reply the page holds without its call, and nothing for a held pair', () => {
    const needs = anchorNeedsOf([
      row(10, 'tool_result', { id: 'orphan' }),
      row(11, 'tool_call', { id: 'paired' }),
      row(12, 'tool_result', { id: 'paired' }),
    ]);
    expect([...needs.toolCallIds]).toEqual(['orphan']);
    expect(needs.pendingResultIds.has('paired')).toBe(false);
  });

  it("asks for the reply of a call the page leaves unanswered — a jump window's bottom edge", () => {
    expect([
      ...anchorNeedsOf([row(10, 'tool_call', { id: 'open' })]).pendingResultIds,
    ]).toEqual(['open']);
  });

  it("asks for a delegate's launching call and its reply off the delegate's own rows", () => {
    const needs = anchorNeedsOf([
      row(10, 'message', { text: 'x', parentToolUseId: 'task-1' }),
    ]);
    expect([...needs.delegateIds]).toEqual(['task-1']);
    expect([...needs.toolCallIds]).toEqual(['task-1']);
    expect([...needs.launchResultIds]).toEqual(['task-1']);
    expect(needs.pendingResultIds.size).toBe(0);
  });

  it("asks for a workflow's launch and announcements off its roster row", () => {
    const needs = anchorNeedsOf([
      row(10, 'workflow_info', { id: 'wf-1', agents: [] }),
    ]);
    expect([...needs.workflowIds]).toEqual(['wf-1']);
    expect(needs.toolCallIds.has('wf-1')).toBe(true);
  });
});

describe('conversationCallIds', () => {
  const starts = [
    { callId: 'call-1', thread: null },
    { callId: 'call-2', thread: 'call-1' },
    { callId: 'call-3', thread: 'call-2' },
    { callId: 'call-4', thread: null },
  ];

  it('reaches every call of the conversation in BOTH directions from any member', () => {
    expect(
      [...conversationCallIds(starts, new Set(['call-2']))].sort(),
    ).toEqual(['call-1', 'call-2', 'call-3']);
  });

  it('leaves an unrelated conversation out', () => {
    expect(conversationCallIds(starts, new Set(['call-4']))).toEqual(
      new Set(['call-4']),
    );
  });

  it("does not join a thread naming a LATER call — the renderer's chain rule", () => {
    // `resolveCallChains` refuses this edge, so anchoring call-7 would hand the
    // client a conversation it draws as a card of its own.
    const members = conversationCallIds(
      [
        { callId: 'call-5', thread: 'call-7' },
        { callId: 'call-7', thread: null },
      ],
      new Set(['call-5']),
    );
    expect(members).toEqual(new Set(['call-5']));
  });
});

describe('workflowEdgeRows', () => {
  it("keeps a workflow's first and newest announcement and none between", () => {
    const rows = [
      row(1, 'workflow_info', { id: 'wf', title: 'Name' }),
      row(5, 'workflow_info', { id: 'wf', agents: [1] }),
      row(9, 'workflow_info', { id: 'wf', agents: [1, 2] }),
      row(3, 'workflow_info', { id: 'other' }),
    ];
    expect(
      workflowEdgeRows(rows, new Set(['wf'])).map((item) => item.seq),
    ).toEqual([1, 9]);
  });
});

describe('pageBoundsOf', () => {
  it('reads an empty page as needing nothing', () => {
    expect(pageBoundsOf([])).toBeNull();
  });
});
