import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MonitorOwner } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import type { ItemCallIndexService } from './item-call-index.service';
import type { ItemSeqAllocator } from './item-seq.allocator';
import { MonitorRegistry } from './monitor.registry';
import { MonitorRowWriter } from './monitor-row.writer';
import { ProcessRegistry } from './process-registry';

const chatOwner: MonitorOwner = {
  runId: 'run-1',
  nodeId: 'agent',
  caller: 'agent',
  conversationId: null,
  callId: null,
  target: 'chat',
};

describe('MonitorRowWriter', () => {
  let registry: MonitorRegistry;
  let created: { nodeId: string | null; payload: string }[];

  beforeEach(() => {
    registry = new MonitorRegistry(new ProcessRegistry());
    created = [];
    const em = { fork: () => em } as unknown as EntityManager;
    let seq = 0;
    new MonitorRowWriter(
      em,
      { getById: async () => ({ id: 'run-1' }) } as unknown as RunDao,
      {
        create: vi.fn(
          async (row: { nodeId: string | null; payload: string }) => {
            created.push(row);
            return { id: `item-${created.length}`, createdAt: new Date() };
          },
        ),
      } as unknown as ItemDao,
      new AgentEventBus(),
      { inCallOf: async () => '' } as unknown as ItemCallIndexService,
      {
        reserve: async () => (seq += 1),
        settle: () => undefined,
      } as unknown as ItemSeqAllocator,
      registry,
    ).onModuleInit();
  });

  afterEach(async () => {
    registry.stopRun('run-1', 'teardown');
    await registry.settled('run-1', 5000);
  });

  it("writes a chat's start and its unannounced end with no node, in the shape the boot sweep reads", async () => {
    registry.start({
      owner: chatOwner,
      command: 'while true; do sleep 1; done',
      description: 'loop',
      timeoutMs: 60_000,
    });
    registry.stop('run-1', 'm1', 'agent');
    await registry.settled('run-1', 5000);

    expect(created.map((row) => row.nodeId)).toEqual([null, null]);
    const payloads = created.map((row) => JSON.parse(row.payload));
    expect(payloads.map((p) => p.monitors[0].event)).toEqual(['start', 'end']);
    expect(payloads[1]).toMatchObject({
      woke: false,
      monitors: [{ id: 'm1', end: { kind: 'stopped' } }],
    });
    // `ItemDao.allMonitorRows` pre-filters on this substring.
    expect(created[0]?.payload).toContain('"monitors":[');
  });

  it("files a team callee's rows under its node and conversation", async () => {
    registry.start({
      owner: {
        ...chatOwner,
        nodeId: 'dev',
        caller: 'dev::call-1',
        conversationId: 'call-1',
        callId: 'call-1',
        target: 'team',
      },
      command: 'true',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled('run-1', 5000);

    expect(created[0]?.nodeId).toBe('dev');
    expect(JSON.parse(created[0]!.payload)).toMatchObject({
      callId: 'call-1',
      conversationId: 'call-1',
    });
  });
});
