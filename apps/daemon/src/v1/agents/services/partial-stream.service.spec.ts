import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDeltaEvent } from '../chat.types';
import type { AgentEventBus } from './agent-events.bus';
import { PartialStreamService } from './partial-stream.service';

const RUN = 'run-1';
const OWNER = 'agent';

let published: RunDeltaEvent[];
let service: PartialStreamService;

beforeEach(() => {
  published = [];
  const bus = {
    publishDelta: (event: RunDeltaEvent) => published.push(event),
  } as unknown as AgentEventBus;
  service = new PartialStreamService(bus);
});

/** The most recent event on the wire. */
function last(): RunDeltaEvent {
  return published[published.length - 1]!;
}

describe('PartialStreamService — thinking accumulates over the TURN', () => {
  it('carries a finished stretch forward instead of restarting the count', () => {
    // The CLI's `estimated_tokens` restarts per reasoning stretch, so a turn
    // that thinks, writes, then thinks again used to show the second stretch's
    // number alone — the count visibly went backwards mid-turn.
    service.thinking(RUN, OWNER, null, 300);
    expect(last().thinkingTokens).toBe(300);

    service.append(RUN, OWNER, null, 'some words');
    expect(last().thinkingTokens).toBeNull(); // not reasoning right now

    service.thinking(RUN, OWNER, null, 120);
    expect(last().thinkingTokens).toBe(420);
  });

  it('reports when the turn started thinking, and keeps that anchor', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      service.thinking(RUN, OWNER, null, 10);
      const started = last().thinkingSince;
      expect(started).toBe(Date.parse('2026-07-29T00:00:00Z'));

      // A later stretch measures elapsed from the FIRST one, so the row reads
      // "this turn has been thinking for a while", not "for 2 seconds".
      vi.setSystemTime(new Date('2026-07-29T00:00:30Z'));
      service.append(RUN, OWNER, null, 'words');
      service.thinking(RUN, OWNER, null, 5);
      expect(last().thinkingSince).toBe(started);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes no thinking anchor while the agent is writing', () => {
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'words');
    expect(last().thinkingSince).toBeNull();
  });

  it('a durable message does NOT reset the turn total — only the tail', () => {
    // `retire` fires per message, and a turn routinely lands several. Resetting
    // the accumulation there would restore exactly the bug above.
    service.thinking(RUN, OWNER, null, 300);
    service.append(RUN, OWNER, null, 'first paragraph');
    service.retire(RUN, OWNER, null);
    expect(last().text).toBe('');

    service.thinking(RUN, OWNER, null, 50);
    expect(last().thinkingTokens).toBe(350);
  });

  it('the TURN boundary resets it', () => {
    service.thinking(RUN, OWNER, null, 300);
    service.clearRun(RUN);
    service.thinking(RUN, OWNER, null, 25);
    expect(last().thinkingTokens).toBe(25);
  });

  it('still skips the tail past the 64 KB cap, banking the stretch anyway', () => {
    // The cap's early return used to skip the thinking null-out too; the
    // accounting must not silently stop just because the tail is full.
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'x'.repeat(64 * 1024 + 10));
    const capped = last().text.length;
    expect(capped).toBe(64 * 1024);
    // The words ended the stretch, so the live indicator clears — this is the
    // assertion the title promises, and without it the cap's early return
    // skipped the banking entirely: past 64 KB the "thinking" row never
    // cleared again for that agent.
    expect(last().thinkingTokens).toBeNull();

    // A second stretch still accumulates ON TOP of the banked one while capped,
    // rather than restarting or being lost.
    service.thinking(RUN, OWNER, null, 7);
    expect(last().thinkingTokens).toBe(17);

    service.append(RUN, OWNER, null, 'more');
    expect(last().text.length).toBe(capped);
    expect(last().thinkingTokens).toBeNull();
  });

  it('does not re-publish the capped tail for deltas that change nothing', () => {
    // The cap exists to stop pushing an unbounded string across the wire on
    // every delta. Banking the stretch there must not reinstate that: once the
    // bank is empty, a further delta has nothing new to say and a 64 KB
    // byte-identical event per delta would lock the renderer on a long dump.
    service.append(RUN, OWNER, null, 'x'.repeat(64 * 1024 + 10));
    const afterCap = published.length;

    service.append(RUN, OWNER, null, 'more');
    service.append(RUN, OWNER, null, 'and more');
    expect(published.length).toBe(afterCap);

    // ...but a delta that ENDS a stretch still reports, because the live
    // thinking row has to clear.
    service.thinking(RUN, OWNER, null, 5);
    const afterThinking = published.length;
    service.append(RUN, OWNER, null, 'words again');
    expect(published.length).toBe(afterThinking + 1);
    expect(last().thinkingTokens).toBeNull();
  });
});

describe('PartialStreamService — live context', () => {
  it('publishes the mid-turn context figure', () => {
    service.context(RUN, OWNER, null, 28_283);
    expect(last().contextTokens).toBe(28_283);
  });

  it('scales it with the window remembered from the last completed turn', () => {
    // The window rides the `result` line only, so without remembering it a
    // turn's first request would report a token count with nothing to scale
    // against — the ring would sit at zero while the number climbed.
    expect(published).toHaveLength(0);
    service.rememberWindow(RUN, 1_000_000);
    service.context(RUN, OWNER, null, 28_283);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('keeps the window across the turn boundary that clears everything else', () => {
    service.rememberWindow(RUN, 1_000_000);
    service.clearRun(RUN);
    service.context(RUN, OWNER, null, 100);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('ignores a missing or nonsensical window rather than storing it', () => {
    service.rememberWindow(RUN, 200_000);
    service.rememberWindow(RUN, null);
    service.rememberWindow(RUN, 0);
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(200_000);
  });

  it('forgetRun drops the window too — the run itself is gone', () => {
    service.rememberWindow(RUN, 1_000_000);
    service.forgetRun(RUN);
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });
});

describe('PartialStreamService — every method stays total', () => {
  it('never throws out into the persist chain when the bus fails', () => {
    // These run inside the turn's persist chain, where a throw marks the run
    // failed. A nicety must not be able to do that.
    const exploding = {
      publishDelta: () => {
        throw new Error('bus down');
      },
    } as unknown as AgentEventBus;
    const fragile = new PartialStreamService(exploding);
    expect(() => fragile.append(RUN, OWNER, null, 'x')).not.toThrow();
    expect(() => fragile.thinking(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.context(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.retire(RUN, OWNER, null)).not.toThrow();
  });
});
