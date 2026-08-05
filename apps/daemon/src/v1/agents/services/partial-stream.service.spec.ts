import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDeltaEvent } from '../chat.types';
import { FakeContextWindowStore } from './__tests__/fake-context-window-store';
import type { AgentEventBus } from './agent-events.bus';
import { PartialStreamService } from './partial-stream.service';

const RUN = 'run-1';
const OWNER = 'agent';
const AGENT = 'claude';

let published: RunDeltaEvent[];
let service: PartialStreamService;
let windowStore: FakeContextWindowStore;

beforeEach(() => {
  published = [];
  const bus = {
    publishDelta: (event: RunDeltaEvent) => published.push(event),
  } as unknown as AgentEventBus;
  windowStore = new FakeContextWindowStore();
  service = new PartialStreamService(bus, windowStore.asStore());
});

/** The most recent event on the wire. */
function last(): RunDeltaEvent {
  return published[published.length - 1]!;
}

describe('PartialStreamService — thinking is scoped to ONE stretch', () => {
  it('starts a new stretch, with its own count, after the agent writes', () => {
    // The CLI's `estimated_tokens` restarts per reasoning stretch and so does
    // the row: a turn that thinks, writes, then thinks again is two separate
    // waits. Carrying the first stretch's total into the second is what made
    // one endless "thinking" row whose number never returned to zero.
    service.thinking(RUN, OWNER, null, 300);
    expect(last().thinkingTokens).toBe(300);
    expect(last().thinkingStretch).toBe(1);

    service.append(RUN, OWNER, null, 'some words');
    expect(last().thinkingTokens).toBeNull(); // not reasoning right now
    expect(last().thinkingStretch).toBeNull();

    service.thinking(RUN, OWNER, null, 120);
    expect(last().thinkingTokens).toBe(120);
    expect(last().thinkingStretch).toBe(2);
  });

  it('more deltas about the SAME stretch keep its identity and its clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      service.thinking(RUN, OWNER, null, 10);
      const started = last().thinkingSince;
      expect(started).toBe(Date.parse('2026-07-29T00:00:00Z'));

      // No `append` between them, so the stretch never closed — the anchor must
      // not move, or the row's elapsed time would restart on every delta.
      vi.setSystemTime(new Date('2026-07-29T00:00:30Z'));
      service.thinking(RUN, OWNER, null, 40);
      expect(last().thinkingSince).toBe(started);
      expect(last().thinkingStretch).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a REOPENED stretch gets a fresh clock, not the previous one', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      service.thinking(RUN, OWNER, null, 10);

      // Words closed the stretch; the next one is a new wait and its elapsed
      // time starts now. Reading 30s here is the "it never cleans the time"
      // defect this reset exists to fix.
      vi.setSystemTime(new Date('2026-07-29T00:00:30Z'));
      service.append(RUN, OWNER, null, 'words');
      service.thinking(RUN, OWNER, null, 5);
      expect(last().thinkingSince).toBe(Date.parse('2026-07-29T00:00:30Z'));
      expect(last().thinkingStretch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes no thinking anchor while the agent is writing', () => {
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'words');
    expect(last().thinkingSince).toBeNull();
    expect(last().thinkingStretch).toBeNull();
  });

  it('a durable message closes the stretch but does not restart the counter', () => {
    // `retire` fires per message, and a turn routinely lands several. The
    // stretch counter is what tells the NEXT stretch apart from this one, so
    // resetting it here would give two different waits the same identity.
    service.thinking(RUN, OWNER, null, 300);
    service.append(RUN, OWNER, null, 'first paragraph');
    service.retire(RUN, OWNER, null);
    expect(last().text).toBe('');

    service.thinking(RUN, OWNER, null, 50);
    expect(last().thinkingTokens).toBe(50);
    expect(last().thinkingStretch).toBe(2);
  });

  it('the TURN boundary resets it', () => {
    service.thinking(RUN, OWNER, null, 300);
    service.clearRun(RUN);
    service.thinking(RUN, OWNER, null, 25);
    expect(last().thinkingTokens).toBe(25);
    expect(last().thinkingStretch).toBe(1);
  });

  it('still closes the stretch past the 64 KB cap', () => {
    // The cap's early return used to skip the thinking null-out too; the
    // accounting must not silently stop just because the tail is full.
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'x'.repeat(64 * 1024 + 10));
    const capped = last().text.length;
    expect(capped).toBe(64 * 1024);
    // The words ended the stretch, so the live indicator clears — this is the
    // assertion the title promises, and without it the cap's early return
    // left the stretch open: past 64 KB the "thinking" row never cleared again
    // for that agent.
    expect(last().thinkingTokens).toBeNull();

    // A second stretch still opens while capped, rather than being lost.
    service.thinking(RUN, OWNER, null, 7);
    expect(last().thinkingTokens).toBe(7);
    expect(last().thinkingStretch).toBe(2);

    service.append(RUN, OWNER, null, 'more');
    expect(last().text.length).toBe(capped);
    expect(last().thinkingTokens).toBeNull();
  });

  it('reports a stretch that has spent no tokens yet, rather than hiding it', () => {
    // A stretch's first delta can carry 0. The row must still appear — the
    // wait is the thing being shown, and `thinkingStretch` is what says it is
    // happening, so a zero count cannot be mistaken for "not thinking".
    service.thinking(RUN, OWNER, null, 0);
    expect(last().thinkingTokens).toBe(0);
    expect(last().thinkingStretch).toBe(1);
    expect(last().thinkingSince).not.toBeNull();
  });

  it('does not re-publish the capped tail for deltas that change nothing', () => {
    // The cap exists to stop pushing an unbounded string across the wire on
    // every delta. Closing the stretch there must not reinstate that: with no
    // stretch open, a further delta has nothing new to say and a 64 KB
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
    const fragile = new PartialStreamService(
      exploding,
      new FakeContextWindowStore().asStore(),
    );
    expect(() => fragile.append(RUN, OWNER, null, 'x')).not.toThrow();
    expect(() => fragile.thinking(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.context(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.retire(RUN, OWNER, null)).not.toThrow();
  });
});

describe('PartialStreamService — the window is a property of the MODEL', () => {
  it('scales a run’s FIRST request from a window learned in an earlier run', () => {
    // The window rides the `result` line only, so a brand-new chat had nothing
    // to scale against until its first turn finished — and the meter fell back
    // to an assumed 200k, which is how a 1M-window model came to be shown a
    // fifth full before it had said anything.
    service.useModel('run-old', AGENT, 'claude-opus-5[1m]');
    service.rememberWindow('run-old', 1_000_000, 'claude-opus-5[1m]');

    service.useModel('run-new', AGENT, 'claude-opus-5[1m]');
    service.context('run-new', OWNER, null, 26_000);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('says nothing rather than guessing for a model never seen before', () => {
    // Unknown must stay unknown: the renderer shows a bare token count for a
    // null window, where a substituted default would state a denominator
    // nobody reported.
    service.useModel(RUN, AGENT, 'some-model-we-have-never-run');
    service.context(RUN, OWNER, null, 26_000);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('keeps the run’s own window across turns while the model is unchanged', () => {
    // The run's own `result` line describes the conversation actually on
    // screen, so re-announcing the SAME model at the next turn's start must not
    // reset the meter to whatever the per-model memory happens to hold.
    service.useModel(RUN, AGENT, 'a-model');
    service.rememberWindow(RUN, 1_000_000, 'a-model');

    service.useModel(RUN, AGENT, 'a-model');
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('does NOT file a fallback model’s window under the announced one', () => {
    // A turn can fall back to a second model, and `result.modelUsage` then
    // reports THAT model's window. Filing it under the model the turn asked for
    // poisons every later chat on the requested model for the life of the
    // process — the 1M-shown-as-200k defect, cached.
    service.useModel(RUN, AGENT, 'big-model');
    service.rememberWindow(RUN, 200_000, 'a-smaller-fallback-model');

    service.useModel('run-next', AGENT, 'big-model');
    service.context('run-next', OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('does not share a window between two CLIs that name the same model', () => {
    // `.claude/rules/agent-adapters.md`: per-agent state is keyed by agent,
    // never by the thing it is about. A window measured through one CLI says
    // nothing about another that happens to accept the same model id.
    service.useModel(RUN, 'claude', 'shared-name');
    service.rememberWindow(RUN, 1_000_000, 'shared-name');

    service.useModel('run-other', 'cursor-agent', 'shared-name');
    service.context('run-other', OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('keeps the per-model memory when a run is deleted', () => {
    // The window describes the model, not the chat — deleting a conversation
    // is no reason for the next one to start guessing again.
    service.useModel(RUN, AGENT, 'a-model');
    service.rememberWindow(RUN, 1_000_000, 'a-model');
    service.forgetRun(RUN);

    service.useModel('run-next', AGENT, 'a-model');
    service.context('run-next', OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('rescales when the chat switches to a model with a different window', () => {
    // A chat is free to change model between turns, and the window is a
    // property of the MODEL. The run-scoped memory below was learned from the
    // PREVIOUS model's result line, so preferring it here measures the new
    // model's context against the old model's window for the whole turn — a
    // 300k request on a 1M model reading "300k / 200k · 150%", which is the
    // very "wrong context" the per-model memory exists to prevent.
    service.useModel(RUN, AGENT, 'small-window-model');
    service.rememberWindow(RUN, 200_000, 'small-window-model');
    // The big model's window was learned from another chat this session.
    service.useModel('run-elsewhere', AGENT, 'big-window-model');
    service.rememberWindow('run-elsewhere', 1_000_000, 'big-window-model');

    // This chat's next turn announces the big model at session start.
    service.useModel(RUN, AGENT, 'big-window-model');
    service.context(RUN, OWNER, null, 300_000);

    expect(last().contextWindowTokens).toBe(1_000_000);
  });
});

describe('PartialStreamService — a settled turn stops claiming to be live', () => {
  it('withdraws a tail the finalizer handed to a durable partial item', () => {
    // The cancel/failure path: `takeTail` gives the watched-but-undurable words
    // to a `partial`-flagged message row, then `clearRun` ends the turn.
    // Neither says so on the wire, so the client is still holding those same
    // words as a LIVE tail and shows the sentence twice — once as the live row,
    // once as the durable item that was written to replace it. The whole point
    // of publishing the WHOLE tail is that the last event is authoritative;
    // here the last event is a lie the moment the flush lands.
    service.append(RUN, OWNER, null, 'half a senten');
    expect(last().text).toBe('half a senten');

    expect(service.takeTail(RUN, OWNER, null)).toBe('half a senten');
    service.clearRun(RUN);

    expect(last().text).toBe('');
  });

  it('closes a reasoning stretch that was open when the turn ended', () => {
    // Stop pressed while the agent is reasoning: the tail is empty, so the
    // flush above never fires and `clearRun` is the only thing that runs. With
    // no event to withdraw it, the last word on the wire still names an OPEN
    // stretch — and the transcript keeps a spinning "Thinking… 4m 12s" row,
    // clock ticking, under a chat whose turn stopped minutes ago.
    service.thinking(RUN, OWNER, null, 300);
    expect(last().thinkingStretch).toBe(1);

    service.clearRun(RUN);

    expect(last().thinkingStretch).toBeNull();
  });
});

describe('PartialStreamService — the window survives a daemon restart', () => {
  it('scales a run’s FIRST request from a window persisted by an EARLIER launch', () => {
    // The reported defect. Both in-memory maps start empty in a fresh process,
    // so before the store existed a run had nothing to scale against until its
    // own first turn COMPLETED — and on a machine where the app is restarted
    // often that is most of what the user ever sees: `ctx 91.6k` with no ring.
    const restarted = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      new FakeContextWindowStore({
        [FakeContextWindowStore.key(AGENT, 'claude-opus-5')]: 1_000_000,
      }).asStore(),
    );

    restarted.useModel(RUN, AGENT, 'claude-opus-5');
    restarted.context(RUN, OWNER, null, 91_600);

    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('writes a newly learned window through, so the NEXT launch already knows it', () => {
    service.useModel(RUN, AGENT, 'claude-opus-5');
    service.rememberWindow(RUN, 1_000_000, 'claude-opus-5');

    expect(windowStore.writes).toEqual([
      { agent: AGENT, model: 'claude-opus-5', window: 1_000_000 },
    ]);
  });

  it('does NOT persist a fallback model’s window under the announced one', () => {
    // The in-memory cache already refuses this; the durable one must refuse it
    // too, or the poisoning that used to last one process would last forever.
    service.useModel(RUN, AGENT, 'big-model');
    service.rememberWindow(RUN, 200_000, 'a-smaller-fallback-model');

    expect(windowStore.writes).toEqual([]);
  });

  it('still says nothing for a model the store has never seen', () => {
    // Persistence must not become a licence to guess: an unknown model stays
    // unknown, which is what keeps the meter honest rather than assuming 200k.
    service.useModel(RUN, AGENT, 'a-model-nobody-has-run');
    service.context(RUN, OWNER, null, 26_000);

    expect(last().contextWindowTokens).toBeNull();
  });
});
