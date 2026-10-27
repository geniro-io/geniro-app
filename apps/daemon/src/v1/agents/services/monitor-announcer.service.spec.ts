import { describe, expect, it } from 'vitest';

import type {
  MonitorEvent,
  MonitorSnapshot,
  RunStatusEvent,
} from '../chat.types';
import { AgentEventBus } from './agent-events.bus';
import type { MonitorRegistry } from './monitor.registry';
import { MonitorAnnouncer } from './monitor-announcer.service';

const snapshot: MonitorSnapshot = {
  id: 'm1',
  description: 'CI',
  command: 'gh pr checks 42 --watch',
  startedAt: '2026-10-27T10:00:00.000Z',
  endsAt: '2026-10-27T10:10:00.000Z',
  timeoutMs: 600_000,
  events: 0,
  pid: 4242,
  owner: {
    runId: 'run-a',
    nodeId: 'chat',
    caller: 'chat',
    conversationId: null,
    callId: null,
    target: 'chat',
  },
};

describe('MonitorAnnouncer', () => {
  it('announces a start and an end on the run, never a batch of output', () => {
    let listener: ((event: MonitorEvent) => unknown) | null = null;
    const registry = {
      subscribe: (l: (event: MonitorEvent) => unknown) => {
        listener = l;
        return () => undefined;
      },
    } as unknown as MonitorRegistry;
    const bus = new AgentEventBus();
    const seen: RunStatusEvent[] = [];
    bus.allStatuses().subscribe((event) => seen.push(event));
    new MonitorAnnouncer(registry, bus).onModuleInit();

    listener!({
      type: 'batch',
      monitor: snapshot,
      batch: { lines: ['ok'], omitted: 0 },
    });
    expect(seen).toEqual([]);

    listener!({ type: 'start', monitor: snapshot });
    listener!({
      type: 'end',
      monitor: snapshot,
      end: { kind: 'exit', code: 0 },
      batch: null,
      wake: true,
      stoppedBy: null,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        runId: 'run-a',
        status: null,
        monitorsChangedAt: expect.any(Number),
      }),
      expect.objectContaining({
        runId: 'run-a',
        status: null,
        monitorsChangedAt: expect.any(Number),
      }),
    ]);
  });
});
