import { describe, expect, it } from 'vitest';

import type { ItemKind } from '../../runs/runs.types';
import {
  callMembershipLookupOf,
  callMembershipOf,
  type CallMembershipRow,
  OUTSIDE_ANY_CALL,
} from './call-membership';

function row(
  kind: ItemKind,
  memberId: string | null,
  payload: unknown,
): CallMembershipRow {
  return { kind, memberId, payload };
}

const start = row('call_started', 'manager', {
  callId: 'call-1',
  calleeNodeId: 'engineer',
});
const lookup = callMembershipLookupOf([
  start,
  row('subagent_info', 'engineer', { id: 'toolu_1', callId: 'call-1' }),
]);

describe('callMembershipOf', () => {
  it("files the callee's own rows under the call", () => {
    expect(
      callMembershipOf(
        row('tool_call', 'engineer', { id: 't1', callId: 'call-1' }),
        lookup,
      ),
    ).toBe('call-1');
  });

  it('files the caller-written question, answer and settle under the call', () => {
    for (const kind of [
      'call_question',
      'call_answer',
      'call_result',
    ] as const) {
      expect(
        callMembershipOf(row(kind, 'manager', { callId: 'call-1' }), lookup),
      ).toBe('call-1');
    }
  });

  it("keeps a member's own call start, the pickup note, approval cards and a callee's published page or button in the run's own flow", () => {
    for (const kind of [
      'call_started',
      'await_collected',
      'approval_request',
      'approval_verdict',
      'show_artifact',
      'action',
      'action_outcome',
    ] as const) {
      expect(
        callMembershipOf(row(kind, 'engineer', { callId: 'call-1' }), lookup),
      ).toBe(OUTSIDE_ANY_CALL);
    }
  });

  describe('a call made by a callee', () => {
    const nested = (
      callId: string,
      memberId: string,
      callerConversationId: string,
    ): CallMembershipRow =>
      row('call_started', memberId, {
        callId,
        calleeNodeId: 'middle',
        callerConversationId,
      });

    it("is filed in the call its caller's conversation answers", () => {
      const rows = [start, nested('call-2', 'engineer', 'call-1')];
      expect(callMembershipOf(rows[1]!, callMembershipLookupOf(rows))).toBe(
        'call-1',
      );
    });

    it('is filed in the newest call of a continued conversation started before it', () => {
      const rows = [
        start,
        row('call_started', 'manager', {
          callId: 'call-2',
          calleeNodeId: 'engineer',
          thread: 'call-1',
        }),
        nested('call-3', 'engineer', 'call-1'),
        row('call_started', 'manager', {
          callId: 'call-4',
          calleeNodeId: 'engineer',
          thread: 'call-2',
        }),
      ];
      expect(callMembershipOf(rows[2]!, callMembershipLookupOf(rows))).toBe(
        'call-2',
      );
    });

    it('is filed the same way when its row is learned as it is written', () => {
      const lookup = callMembershipLookupOf([start]);
      const made = nested('call-2', 'engineer', 'call-1');
      lookup.learn(made);
      expect(callMembershipOf(made, lookup)).toBe('call-1');
    });

    it("stays in the run's own flow when its caller is not that conversation's callee", () => {
      const rows = [start, nested('call-2', 'qa', 'call-1')];
      expect(callMembershipOf(rows[1]!, callMembershipLookupOf(rows))).toBe(
        OUTSIDE_ANY_CALL,
      );
    });

    it("stays in the run's own flow when the conversation it names never started", () => {
      const rows = [start, nested('call-2', 'engineer', 'call-9')];
      expect(callMembershipOf(rows[1]!, callMembershipLookupOf(rows))).toBe(
        OUTSIDE_ANY_CALL,
      );
    });
  });

  it('keeps a row another member wrote about the call in the main flow', () => {
    expect(
      callMembershipOf(
        row('system', 'manager', { callId: 'call-1', stalledCall: true }),
        lookup,
      ),
    ).toBe(OUTSIDE_ANY_CALL);
  });

  it('keeps a row naming a call the run never started in the main flow', () => {
    expect(
      callMembershipOf(
        row('message', 'engineer', { callId: 'call-9', text: 'hi' }),
        lookup,
      ),
    ).toBe(OUTSIDE_ANY_CALL);
    expect(
      callMembershipOf(
        row('call_result', 'manager', { callId: 'call-9' }),
        lookup,
      ),
    ).toBe(OUTSIDE_ANY_CALL);
  });

  it('files a delegate row that names no call under the call its delegate was launched in', () => {
    expect(
      callMembershipOf(
        row('subagent_info', 'engineer', {
          id: 'toolu_1',
          status: 'completed',
        }),
        lookup,
      ),
    ).toBe('call-1');
  });

  it('keeps a row with no call in the main flow', () => {
    expect(
      callMembershipOf(row('message', 'manager', { text: 'plan' }), lookup),
    ).toBe(OUTSIDE_ANY_CALL);
  });
});

describe('callMembershipLookupOf', () => {
  it("keeps a call's FIRST start and learns rows added later", () => {
    const later = callMembershipLookupOf([start]);
    later.learn(
      row('call_started', 'manager', { callId: 'call-1', calleeNodeId: 'qa' }),
    );
    later.learn(
      row('call_started', 'engineer', { callId: 'call-2', calleeNodeId: 'qa' }),
    );
    expect(later.calleeNodeOf('call-1')).toBe('engineer');
    expect(later.calleeNodeOf('call-2')).toBe('qa');
    expect(later.calleeNodeOf('call-3')).toBeUndefined();
  });
});
