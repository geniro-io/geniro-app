import { describe, expect, it } from 'vitest';

import {
  applyLiveText,
  CHAT_LIVE_KEY,
  type LiveState,
  type LiveTextEvent,
  parseLiveText,
} from './live-text';

const event = (over: Partial<LiveTextEvent> = {}): LiveTextEvent => ({
  runId: 'run-1',
  nodeId: null,
  text: '',
  thinkingTokens: null,
  thinkingSince: null,
  contextTokens: null,
  contextWindowTokens: null,
  ...over,
});

describe('parseLiveText', () => {
  it('reads a well-formed delta off the untyped wire payload', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        nodeId: 'node-a',
        text: 'hello',
        thinkingTokens: 120,
        contextTokens: 45_200,
        contextWindowTokens: 200_000,
      }),
    ).toEqual({
      runId: 'run-1',
      nodeId: 'node-a',
      text: 'hello',
      thinkingTokens: 120,
      thinkingSince: null,
      contextTokens: 45_200,
      contextWindowTokens: 200_000,
    });
  });

  it('rejects a ZERO or negative number as "not reported"', () => {
    // A window of 0 is not a window: consumers read it as `?? DEFAULT`, which
    // passes 0 straight through into ContextMeter's divide. `agent-activity.ts`
    // rejects it on the durable-item path; without the same rule here the LIVE
    // path would leak one, which is the asymmetry this guard closes.
    const parsed = parseLiveText({
      runId: 'run-1',
      nodeId: null,
      text: '',
      thinkingTokens: 0,
      thinkingSince: -1,
      contextTokens: 0,
      contextWindowTokens: 0,
    });
    expect(parsed).toEqual({
      runId: 'run-1',
      nodeId: null,
      text: '',
      thinkingTokens: null,
      thinkingSince: null,
      contextTokens: null,
      contextWindowTokens: null,
    });
  });

  it('rejects a payload with no run id, and a non-string node id', () => {
    expect(parseLiveText({ text: 'x' })).toBeNull();
    expect(parseLiveText(null)).toBeNull();
    expect(parseLiveText('not an object')).toBeNull();
    expect(parseLiveText({ runId: 'r', nodeId: 42, text: 'x' })?.nodeId).toBe(
      null,
    );
  });
});

describe('applyLiveText', () => {
  const stored = (map: ReadonlyMap<string, LiveState>): LiveState | undefined =>
    map.get(CHAT_LIVE_KEY);

  it('KEEPS an entry that carries only a context figure', () => {
    // A context figure keeps arriving after the words go durable. Dropping the
    // entry then would blank the meter mid-turn — the entry is kept, and it is
    // `withLiveText` that declines to draw a bubble for it.
    const next = applyLiveText(new Map(), event({ contextTokens: 45_200 }));
    expect(stored(next)?.contextTokens).toBe(45_200);
  });

  it('REMOVES an entry with nothing at all to say', () => {
    const seeded = applyLiveText(new Map(), event({ text: 'writing…' }));
    expect(stored(seeded)).toBeDefined();

    expect(stored(applyLiveText(seeded, event()))).toBeUndefined();
  });

  it('keeps an entry that has words, or a reasoning total, alone', () => {
    expect(stored(applyLiveText(new Map(), event({ text: 'hi' })))?.text).toBe(
      'hi',
    );
    expect(
      stored(applyLiveText(new Map(), event({ thinkingTokens: 12 })))
        ?.thinkingTokens,
    ).toBe(12);
  });

  it('keys a graph node separately from the single-agent chat', () => {
    const next = applyLiveText(
      new Map(),
      event({ nodeId: 'node-a', text: 'hi' }),
    );
    expect(next.get('node-a')?.text).toBe('hi');
    expect(next.get(CHAT_LIVE_KEY)).toBeUndefined();
  });
});
