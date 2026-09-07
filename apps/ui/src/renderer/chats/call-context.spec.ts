import { describe, expect, it } from 'vitest';

import { resolveCalleeContext } from './call-context';
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
        workedMs: null,
        toolCalls: null,
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
      { callId: 'call-1', contextTokens: 64_500, contextWindowTokens: 200_000 },
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
      { callId: 'call-1', contextTokens: 64_500, contextWindowTokens: 200_000 },
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
      { callId: 'call-1', contextTokens: 64_500, contextWindowTokens: 200_000 },
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
      { callId: 'call-2', contextTokens: 64_500, contextWindowTokens: 200_000 },
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
