import { describe, expect, it } from 'vitest';

import {
  applyLiveText,
  CHAT_LIVE_KEY,
  formatLiveSpend,
  type LiveState,
  type LiveTextEvent,
  liveTextKey,
  OWNER_KEY_SEPARATOR,
  ownerOfKey,
  parseLiveText,
  partialOwnerKey,
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
  spentInputTokens: null,
  spentOutputTokens: null,
  spentCacheReadTokens: null,
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
        spentInputTokens: null,
        spentOutputTokens: null,
        spentCacheReadTokens: null,
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
      spentInputTokens: null,
      spentOutputTokens: null,
      spentCacheReadTokens: null,
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
      spentInputTokens: null,
      spentOutputTokens: null,
      spentCacheReadTokens: null,
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
      spentInputTokens: null,
      spentOutputTokens: null,
      spentCacheReadTokens: null,
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

describe('the owner-key twin', () => {
  it('composes a node’s own turn as the bare node id', () => {
    expect(partialOwnerKey('reviewer', null)).toBe('reviewer');
  });

  it('composes a CALL thread with the separator the daemon publishes under', () => {
    expect(partialOwnerKey('reviewer', 'call-1')).toBe('reviewer::call-1');
  });

  it('reads the node back out of either shape', () => {
    expect(ownerOfKey(partialOwnerKey('reviewer', null))).toBe('reviewer');
    expect(ownerOfKey(partialOwnerKey('reviewer', 'call-1'))).toBe('reviewer');
  });

  it('keeps a node id that itself contains the separator whole', () => {
    // Splits at the FIRST separator, so a call id may contain one and a node id
    // may not. This pins THIS side only — a renderer assertion cannot see the
    // daemon's decomposer; `partial-stream.service.spec.ts` pins that one.
    expect(
      ownerOfKey(partialOwnerKey('reviewer', `a${OWNER_KEY_SEPARATOR}b`)),
    ).toBe('reviewer');
  });

  it('gives two calls of one node two entries', () => {
    // The defect the per-call key exists for: keyed by node alone the two
    // shared an entry and the last writer won, so a caller running the same
    // callee twice showed one ring flickering between two conversations.
    const first = applyLiveText(
      new Map(),
      event({
        nodeId: 'a',
        ownerKey: partialOwnerKey('a', 'call-1'),
        text: 'one',
      }),
    );
    const both = applyLiveText(
      first,
      event({
        nodeId: 'a',
        ownerKey: partialOwnerKey('a', 'call-2'),
        text: 'two',
      }),
    );

    expect(both.get('a::call-1')?.text).toBe('one');
    expect(both.get('a::call-2')?.text).toBe('two');
  });
});

describe('liveTextKey', () => {
  it("keys a 1:1 chat's delta by the sentinel, not by the owner key it carries", () => {
    // The drift this exists to stop: the daemon publishes `SINGLE_AGENT_NODE`
    // ('agent') as a chat's owner key, and the sentinel here was renamed away
    // from that very word. Every reader that has no event to derive a key from
    // — `workingAgents`, `awaitingAnswer`, the context meter's live source —
    // asks for the sentinel, so the two could never match. REPORTED as a chat
    // showing `Thinking…` and `Working…` at once, which is the working
    // fallback failing to see that the agent already had a live row.
    expect(liveTextKey(null, 'agent')).toBe(CHAT_LIVE_KEY);
    expect(liveTextKey(null, null)).toBe(CHAT_LIVE_KEY);
  });

  it('leaves a workflow node named `agent` as itself', () => {
    // The collision the sentinel was introduced for, and the reason the
    // discriminator is the NODE ID rather than the owner key's value: a node's
    // delta always carries its id, a chat's never does.
    expect(liveTextKey('agent', 'agent')).toBe('agent');
    expect(liveTextKey('agent', partialOwnerKey('agent', 'call-1'))).toBe(
      `agent${OWNER_KEY_SEPARATOR}call-1`,
    );
  });

  it('round-trips through the inverse for every shape', () => {
    // `ownerOfKey` is what turns a key back into a node, and a key the
    // inverse cannot read is one whose live row lands in a phantom block.
    expect(ownerOfKey(liveTextKey('node-a', 'node-a'))).toBe('node-a');
    expect(
      ownerOfKey(liveTextKey('node-a', partialOwnerKey('node-a', 'c1'))),
    ).toBe('node-a');
  });
});

describe('formatLiveSpend', () => {
  const unmeasured = {
    spentInputTokens: null,
    spentOutputTokens: null,
    spentCacheReadTokens: null,
  };

  it('draws NOTHING when neither half was measured', () => {
    // Every cursor turn, and every claude turn before its first request lands.
    // A `↑0 ↓0` there would be a figure nobody took.
    expect(formatLiveSpend(unmeasured)).toBeNull();
  });

  it('folds cache reads into the input side', () => {
    // The split is priced apart and reported apart, and it decides a BILL. On
    // this row it would be a third figure competing with the activity phrase
    // for one line, so the glance gets two arrows and the wire keeps three
    // fields.
    expect(
      formatLiveSpend({
        spentInputTokens: 1_200,
        spentOutputTokens: 340,
        spentCacheReadTokens: 58_800,
      }),
    ).toBe('↑60k ↓340');
  });

  it('draws a measured ZERO — it is what a turn that has produced nothing says', () => {
    // The distinction the whole plane is built on: 0 was measured, null was
    // not. A turn thinking its way through a long prompt has spent input and
    // produced nothing, and saying so is the point of a live row.
    expect(
      formatLiveSpend({
        spentInputTokens: 4_000,
        spentOutputTokens: 0,
        spentCacheReadTokens: null,
      }),
    ).toBe('↑4k ↓0');
  });

  it('states the half it has when the other is unmeasured', () => {
    expect(formatLiveSpend({ ...unmeasured, spentOutputTokens: 12 })).toBe(
      '↓12',
    );
    expect(formatLiveSpend({ ...unmeasured, spentInputTokens: 12 })).toBe(
      '↑12',
    );
  });
});
