import { Logger } from '@nestjs/common';
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

  it('abandon drops ONE entry without delivering a verdict', () => {
    // The caller gave up on its own call, so there is nothing to respond WITH —
    // calling `respond` here would settle the parked promise with an answer the
    // user never gave. It returns the entry precisely so the caller can write
    // the `unanswerable` row that closes the card.
    let responses = 0;
    const registry = new ApprovalRegistry();
    registry.track(
      pending({
        requestId: 'gone',
        respond: () => {
          responses += 1;
          return true;
        },
      }),
    );
    registry.track(pending({ requestId: 'stays', question: true }));

    const abandoned = registry.abandon('r1', 'gone');

    expect(abandoned?.requestId).toBe('gone');
    expect(responses).toBe(0);
    // Only the one named — the sibling card is still answerable.
    expect(registry.listByRun('r1').map((p) => p.requestId)).toEqual(['stays']);
    // And a verdict arriving for it afterwards is refused rather than lost.
    expect(registry.resolve('r1', 'gone', true)).toBe(false);
  });

  it('abandon answers null for a request already resolved', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ requestId: 'answered' }));
    registry.resolve('r1', 'answered', true);

    expect(registry.abandon('r1', 'answered')).toBeNull();
  });
});

describe('ApprovalRegistry card ids', () => {
  it('mints a DIFFERENT card id for the same protocol id every time', () => {
    // A CLI's request ids restart per process — cursor numbers `n:0`, `n:1`, …
    // per connection — so the protocol id alone cannot name a card.
    const registry = new ApprovalRegistry();
    const a = registry.mintCardId('n:1', 'run::node:a');
    const b = registry.mintCardId('n:1', 'run::node:b');
    const again = registry.mintCardId('n:1', 'run::node:a');

    expect(new Set([a, b, again]).size).toBe(3);
    // The scope and the protocol id stay readable in it, for a log reader.
    expect(a.startsWith('run::node:a#n:1#')).toBe(true);
    expect(registry.mintCardId('n:1').startsWith('n:1#')).toBe(true);
  });

  it('says so when a track DISPLACES a card that is still pending', () => {
    // The displaced card stays on screen, and a verdict on it now answers the
    // new request — the wrong-card defect, which nothing else would surface.
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const registry = new ApprovalRegistry();
      registry.track(pending({ nodeId: 'a', toolName: 'Write' }));
      expect(warn).not.toHaveBeenCalled();

      registry.track(pending({ nodeId: 'b', toolName: 'Bash' }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(
        /replaced one still pending/,
      );
      expect(String(warn.mock.calls[0]![0])).toContain("'Write' on a");
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ApprovalRegistry deferred cards', () => {
  it('leaves a deferred card alone when its node\u2019s turn settles', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ requestId: 'parked' }));
    registry.track(pending({ requestId: 'standing', deferred: true }));

    const swept = registry.sweepNode('r1', 'n1');

    // The parked one is a CALL and the turn that held it is over; the standing
    // one has no call behind it, so the settle says nothing about whether it
    // can still be answered.
    expect(swept.map((p) => p.requestId)).toEqual(['parked']);
    expect(registry.listByRun('r1').map((p) => p.requestId)).toEqual([
      'standing',
    ]);
    expect(registry.awaitingFor('r1')).not.toBeNull();
    expect(registry.resolve('r1', 'standing', true, 'yes')).toBe(true);
  });

  it('sweepDeferred drops only the standing cards, and returns them', () => {
    const registry = new ApprovalRegistry();
    registry.track(pending({ requestId: 'parked' }));
    registry.track(pending({ requestId: 'standing', deferred: true }));
    registry.track(pending({ runId: 'other', deferred: true }));

    const swept = registry.sweepDeferred('r1');

    // Returned rather than dropped, because the caller owes each one an
    // `unanswerable` row \u2014 the card is on screen with live buttons.
    expect(swept.map((p) => p.requestId)).toEqual(['standing']);
    expect(registry.listByRun('r1').map((p) => p.requestId)).toEqual([
      'parked',
    ]);
    expect(registry.resolve('r1', 'standing', true)).toBe(false);
    // Another run's standing card is untouched.
    expect(registry.listByRun('other')).toHaveLength(1);
  });
});
