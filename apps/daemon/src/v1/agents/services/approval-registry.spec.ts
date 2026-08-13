import { describe, expect, it, vi } from 'vitest';

import { ApprovalRegistry, type PendingApproval } from './approval-registry';

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    runId: 'r1',
    nodeId: 'n1',
    requestId: 'req-1',
    toolName: 'Write',
    input: {},
    question: false,
    respond: vi.fn(() => true),
    ...over,
  };
}

describe('ApprovalRegistry.awaitingFor', () => {
  it('says nothing for a run with no open request', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ runId: 'other' }));

    expect(registry.awaitingFor('r1')).toBeNull();
  });

  it('reports an open permission gate as an approval', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending());

    expect(registry.awaitingFor('r1')).toBe('approval');
  });

  it('reports the agent asking as a question', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ toolName: 'AskUserQuestion', question: true }));

    expect(registry.awaitingFor('r1')).toBe('question');
  });

  it('lets a question outrank an approval open at the same time', () => {
    // A turn can hold both. What the user is blocked on, in the sense that
    // matters to them, is the one the agent is ASKING — "waiting for approval"
    // would send them looking for a button while a prompt is on screen.
    const registry = new ApprovalRegistry();
    registry.track(pending({ requestId: 'a' }));
    registry.track(pending({ requestId: 'q', question: true }));

    expect(registry.awaitingFor('r1')).toBe('question');
  });

  it('stops reporting once the request is resolved', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ question: true }));
    registry.resolve('r1', 'req-1', true);

    expect(registry.awaitingFor('r1')).toBeNull();
  });

  it('keeps reporting a SECOND open request after the first is answered', () => {
    // The reason `announceAwaiting` re-reads the registry instead of publishing
    // "the kind that just closed": answering one card does not unpark a turn
    // that is holding another.
    const registry = new ApprovalRegistry();
    registry.track(pending({ requestId: 'first', question: true }));
    registry.track(pending({ requestId: 'second' }));
    registry.resolve('r1', 'first', true);

    expect(registry.awaitingFor('r1')).toBe('approval');
  });

  it('stops reporting once the turn settles and its cards are swept', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ question: true }));
    registry.sweepNode('r1', 'n1');

    expect(registry.awaitingFor('r1')).toBeNull();
  });
});
