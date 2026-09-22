import { describe, expect, it } from 'vitest';

import { NO_TOTALS, totals } from '../__tests__/chat-totals';
import {
  resolveCalleeContext,
  resolveConversationContext,
  resolveConversationSpend,
  spendOfTotals,
} from './call-context';
import { type LiveState, partialOwnerKey } from './live-text';
import type { NodeDurableReading } from './use-node-context';

function live(
  contextTokens: number | null,
  contextWindowTokens: number | null,
): LiveState {
  return {
    text: '',
    thinkingTokens: null,
    thinkingText: null,
    thinkingSince: null,
    thinkingStretch: null,
    composingTool: null,
    composingBytes: null,
    contextTokens,
    contextWindowTokens,
    spentInputTokens: null,
    spentOutputTokens: null,
    spentCacheReadTokens: null,
  };
}

function reading(
  calls: NodeDurableReading['calls'],
): ReadonlyMap<string, NodeDurableReading> {
  return new Map([
    [
      'callee',
      {
        contextTokens: null,
        contextWindowTokens: null,
        calls,
        totals: NO_TOTALS,
        mainTotals: NO_TOTALS,
        workedMs: null,
        toolCalls: null,
        status: 'running',
        startedAt: null,
      },
    ],
  ]);
}

const NO_LIVE: ReadonlyMap<string, LiveState> = new Map();
const NO_ROWS: ReadonlyMap<string, NodeDurableReading> = new Map();

describe('resolveCalleeContext', () => {
  it('reads the live plane under the per-CALL owner key', () => {
    // The key is the whole point: a node serving two calls at once holds two
    // windows, and keyed by node alone they would share one entry with the
    // last writer winning — which is the defect `liveTextKey` records.
    const liveText = new Map([
      [partialOwnerKey('callee', 'call-1'), live(80_414, 200_000)],
      [partialOwnerKey('callee', 'call-2'), live(12_000, 200_000)],
    ]);

    expect(resolveCalleeContext(liveText, NO_ROWS, 'callee', 'call-1')).toEqual(
      {
        contextTokens: 80_414,
        contextWindowTokens: 200_000,
      },
    );
    expect(resolveCalleeContext(liveText, NO_ROWS, 'callee', 'call-2')).toEqual(
      {
        contextTokens: 12_000,
        contextWindowTokens: 200_000,
      },
    );
  });

  it('falls back to the daemon’s durable row for the call', () => {
    // What a reloaded window has and the live plane does not: the plane is
    // throwaway state, so on a first open there is nothing in it at all.
    const rows = reading([
      {
        callId: 'call-1',
        contextTokens: 64_500,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);

    expect(resolveCalleeContext(NO_LIVE, rows, 'callee', 'call-1')).toEqual({
      contextTokens: 64_500,
      contextWindowTokens: 200_000,
    });
  });

  it('prefers LIVE over the durable row', () => {
    // The row moves on the daemon's own write schedule and is fetched on run
    // open and reconnect only; a delta is this turn's latest request.
    const rows = reading([
      {
        callId: 'call-1',
        contextTokens: 64_500,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);
    const liveText = new Map([
      [partialOwnerKey('callee', 'call-1'), live(80_414, 200_000)],
    ]);

    expect(resolveCalleeContext(liveText, rows, 'callee', 'call-1')).toEqual({
      contextTokens: 80_414,
      contextWindowTokens: 200_000,
    });
  });

  it('falls back PER FIGURE — a live count does not erase a durable window', () => {
    // The daemon's own rule: a reading that omits one half says nothing about
    // it. A delta carrying a count and no window would otherwise take the
    // gauge's denominator away and leave a ring that cannot be drawn.
    const rows = reading([
      {
        callId: 'call-1',
        contextTokens: 64_500,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);
    const liveText = new Map([
      [partialOwnerKey('callee', 'call-1'), live(80_414, null)],
    ]);

    expect(resolveCalleeContext(liveText, rows, 'callee', 'call-1')).toEqual({
      contextTokens: 80_414,
      contextWindowTokens: 200_000,
    });
  });

  it('answers UNMEASURED when neither source knows this call', () => {
    const rows = reading([
      {
        callId: 'call-2',
        contextTokens: 64_500,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);

    expect(resolveCalleeContext(NO_LIVE, rows, 'callee', 'call-1')).toEqual({
      contextTokens: null,
      contextWindowTokens: null,
    });
    expect(resolveCalleeContext(NO_LIVE, NO_ROWS, 'nobody', 'call-1')).toEqual({
      contextTokens: null,
      contextWindowTokens: null,
    });
  });
});

describe('resolveConversationContext', () => {
  it('takes the conversation’s LATEST call’s reading over an earlier call’s', () => {
    // A continued conversation is one session: its newest call is where the
    // window stands now, and the first call's row is an older level of it.
    const rows = reading([
      {
        callId: 'call-22',
        contextTokens: 40_000,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
      {
        callId: 'call-24',
        contextTokens: 90_000,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);
    expect(
      resolveConversationContext(NO_LIVE, rows, 'callee', [
        'call-22',
        'call-23',
        'call-24',
      ]),
    ).toEqual({ contextTokens: 90_000, contextWindowTokens: 200_000 });
  });

  it('falls back to an earlier call while the latest has reported nothing yet', () => {
    const rows = reading([
      {
        callId: 'call-22',
        contextTokens: 40_000,
        contextWindowTokens: null,
        totals: NO_TOTALS,
        start: null,
      },
      {
        callId: 'call-23',
        contextTokens: 55_000,
        contextWindowTokens: 200_000,
        totals: NO_TOTALS,
        start: null,
      },
    ]);
    const liveText = new Map([
      [partialOwnerKey('callee', 'call-24'), live(null, 1_000_000)],
    ]);
    expect(
      resolveConversationContext(liveText, rows, 'callee', [
        'call-22',
        'call-23',
        'call-24',
      ]),
    ).toEqual({ contextTokens: 55_000, contextWindowTokens: 1_000_000 });
  });
});

describe('resolveConversationSpend', () => {
  it('sums the WHOLE run’s spend across every call of the conversation', () => {
    // The daemon's per-call totals, not the window's fold: a conversation
    // continued three times, its first call far above the loaded page, costs
    // what all three cost.
    const rows = reading([
      {
        callId: 'call-10',
        contextTokens: null,
        contextWindowTokens: null,
        totals: totals({
          turns: 4,
          costUsd: 40,
          inputTokens: 1_000,
          outputTokens: 500,
        }),
        start: null,
      },
      {
        callId: 'call-12',
        contextTokens: null,
        contextWindowTokens: null,
        totals: totals({ turns: 1, costUsd: 12.38, outputTokens: 250 }),
        start: null,
      },
    ]);
    expect(
      resolveConversationSpend(rows, 'callee', [
        'call-10',
        'call-11',
        'call-12',
      ]),
    ).toEqual({ tokens: 1_750, costUsd: 52.38 });
  });

  it('answers null when no call has a durable figure, so the caller folds instead', () => {
    const rows = reading([
      {
        callId: 'call-1',
        contextTokens: 5,
        contextWindowTokens: 10,
        totals: NO_TOTALS,
        start: null,
      },
    ]);
    expect(resolveConversationSpend(rows, 'callee', ['call-1'])).toBeNull();
    expect(resolveConversationSpend(rows, 'nobody', ['call-1'])).toBeNull();
  });

  it('keeps an unpriced turn’s cost NOT MEASURED rather than zero', () => {
    // cursor reports tokens and no cost: a `$0.00` would be a claim nobody made.
    expect(
      spendOfTotals(totals({ turns: 2, inputTokens: 10, outputTokens: 5 })),
    ).toEqual({ tokens: 15, costUsd: null });
  });
});
