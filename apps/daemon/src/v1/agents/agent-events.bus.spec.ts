import { describe, expect, it } from 'vitest';

import { AgentEventBus } from './agent-events.bus';
import type { ItemWire, RunItemEvent } from './chat.types';

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
