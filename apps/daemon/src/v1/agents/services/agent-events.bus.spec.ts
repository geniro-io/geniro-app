import { describe, expect, it } from 'vitest';

import type { ItemWire, RunItemEvent, RunStatusEvent } from '../chat.types';
import { AgentEventBus } from './agent-events.bus';
import { RunContextRegistry } from './run-context.registry';

function wireItem(runId: string, seq: number): ItemWire {
  return {
    id: `i-${seq}`,
    runId,
    nodeId: null,
    seq,
    kind: 'message',
    role: 'assistant',
    payload: { text: 'hi' },
    createdAt: new Date(0).toISOString(),
  };
}

describe('AgentEventBus', () => {
  it('delivers published events to a subscriber of all()', () => {
    const bus = new AgentEventBus();
    const received: RunItemEvent[] = [];
    const sub = bus.all().subscribe((e) => received.push(e));

    bus.publish({ runId: 'r1', item: wireItem('r1', 0) });
    bus.publish({ runId: 'r2', item: wireItem('r2', 0) });

    expect(received.map((e) => e.runId)).toEqual(['r1', 'r2']);
    sub.unsubscribe();
  });

  it('stamps the run’s context reading onto every status event', () => {
    // The seam the whole fix rests on. There are five announce sites in the
    // chat service, three in the title service and one shared settle helper —
    // a reading carried by "whichever of those remembered" is one that goes
    // stale at the next site somebody writes, which is how the ring came to be
    // an hour behind on a thread that worked while the user was elsewhere.
    const contexts = new RunContextRegistry();
    contexts.remember('r1', { tokens: 42_000, window: 200_000 });
    const bus = new AgentEventBus(contexts);
    const seen: RunStatusEvent[] = [];
    const sub = bus.allStatuses().subscribe((e) => seen.push(e));

    // An ACTIVITY announce — the commonest one, and the one that says nothing
    // about context at all. It carries the reading anyway.
    bus.publishRunStatus({
      runId: 'r1',
      status: null,
      activity: 'running Bash',
    });
    // …and a settle, which is the moment after which the figure cannot move.
    bus.publishRunStatus({ runId: 'r1', status: 'completed' });

    expect(seen).toHaveLength(2);
    for (const event of seen) {
      expect(event.contextTokens).toBe(42_000);
      expect(event.contextWindowTokens).toBe(200_000);
    }
    sub.unsubscribe();
  });

  it('says nothing about a run it has no reading for', () => {
    // Absence must stay absence: the client holds the row its list fetch gave
    // it, and an announce that invented a figure would overwrite a real one
    // with nothing after a daemon restart, when the registry is empty.
    const bus = new AgentEventBus(new RunContextRegistry());
    const seen: RunStatusEvent[] = [];
    const sub = bus.allStatuses().subscribe((e) => seen.push(e));

    bus.publishRunStatus({ runId: 'r1', status: 'completed' });

    expect(seen[0]).not.toHaveProperty('contextTokens');
    sub.unsubscribe();
  });

  it('lets a producer that states the pair itself keep the last word', () => {
    const contexts = new RunContextRegistry();
    contexts.remember('r1', { tokens: 42_000, window: 200_000 });
    const bus = new AgentEventBus(contexts);
    const seen: RunStatusEvent[] = [];
    const sub = bus.allStatuses().subscribe((e) => seen.push(e));

    bus.publishRunStatus({
      runId: 'r1',
      status: null,
      contextTokens: null,
      contextWindowTokens: 200_000,
    });

    expect(seen[0]?.contextTokens).toBeNull();
    sub.unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new AgentEventBus();
    const received: RunItemEvent[] = [];
    const sub = bus.all().subscribe((e) => received.push(e));

    bus.publish({ runId: 'r1', item: wireItem('r1', 0) });
    sub.unsubscribe();
    bus.publish({ runId: 'r1', item: wireItem('r1', 1) });

    expect(received).toHaveLength(1);
  });
});
