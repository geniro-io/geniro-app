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
  ownerKey: null,
  thinkingTokens: null,
  thinkingText: null,
  thinkingSince: null,
  thinkingStretch: null,
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
        ownerKey: null,
        thinkingTokens: 120,
        thinkingStretch: 2,
        contextTokens: 45_200,
        contextWindowTokens: 200_000,
      }),
    ).toEqual({
      runId: 'run-1',
      nodeId: 'node-a',
      text: 'hello',
      ownerKey: null,
      thinkingTokens: 120,
      thinkingText: null,
      thinkingSince: null,
      thinkingStretch: 2,
      contextTokens: 45_200,
      contextWindowTokens: 200_000,
    });
  });

  it('reads the reasoning TEXT a CLI that discloses its thinking sends', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        nodeId: null,
        text: '',
        thinkingText: 'listing the primes',
        thinkingStretch: 1,
      })?.thinkingText,
    ).toBe('listing the primes');
  });

  it('reads an EMPTY reasoning text as none at all', () => {
    // '' and "this CLI redacts its thinking" are the same reading — neither has
    // anything to show — and letting the empty string through would draw a
    // reasoning bubble with no words in it.
    expect(
      parseLiveText({
        runId: 'run-1',
        nodeId: null,
        text: '',
        thinkingText: '',
        thinkingStretch: 1,
      })?.thinkingText,
    ).toBeNull();
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
      thinkingSince: -1,
      thinkingStretch: 0,
      contextTokens: 0,
      contextWindowTokens: 0,
    });
    expect(parsed).toEqual({
      runId: 'run-1',
      nodeId: null,
      text: '',
      ownerKey: null,
      thinkingTokens: null,
      thinkingText: null,
      thinkingSince: null,
      thinkingStretch: null,
      contextTokens: null,
      contextWindowTokens: null,
    });
  });

  it('KEEPS a zero token count — a stretch may not have spent any yet', () => {
    // The one field on this event whose zero is a real answer. Reading it as
    // "not reported" would hide the thinking row for exactly as long as the
    // agent had nothing to show for the wait; `thinkingStretch` is what says
    // whether the agent is thinking, so this field does not have to.
    const parsed = parseLiveText({
      runId: 'run-1',
      nodeId: null,
      text: '',
      ownerKey: null,
      thinkingTokens: 0,
      thinkingStretch: 1,
    });
    expect(parsed?.thinkingTokens).toBe(0);
    expect(parsed?.thinkingStretch).toBe(1);
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

  it('keeps an entry that has words, or an open reasoning stretch, alone', () => {
    expect(stored(applyLiveText(new Map(), event({ text: 'hi' })))?.text).toBe(
      'hi',
    );
    // Retention keys on the STRETCH, not the token count: a stretch that has
    // spent nothing yet is still a wait the transcript has to show, and
    // keying on tokens would drop it.
    const thinking = stored(
      applyLiveText(
        new Map(),
        event({ thinkingStretch: 1, thinkingTokens: 0 }),
      ),
    );
    expect(thinking?.thinkingStretch).toBe(1);
    expect(thinking?.thinkingTokens).toBe(0);
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
