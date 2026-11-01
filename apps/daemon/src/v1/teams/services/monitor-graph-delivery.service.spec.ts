import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MonitorOwner } from '../../agents/chat.types';
import { MonitorRegistry } from '../../agents/services/monitor.registry';
import type { MonitorRowWriter } from '../../agents/services/monitor-row.writer';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { MonitorGraphDelivery } from './monitor-graph-delivery.service';
import type { MonitorWake, TeamExecutorService } from './team-executor.service';

const owner: MonitorOwner = {
  runId: 'run-1',
  memberId: 'dev',
  caller: 'dev',
  conversationId: null,
  callId: null,
  target: 'team',
};

/** An executor whose conversation is busy until told, recording its wakes. */
function fakeExecutor() {
  let answer: MonitorWake = 'busy';
  let turnEnded: (runId: string, caller: string) => void = () => undefined;
  let outputHeld: (runId: string, caller: string) => boolean = () => false;
  const wakeConversation = vi.fn<TeamExecutorService['wakeConversation']>(
    () => answer,
  );
  const reviewMonitorHold = vi.fn();
  const executor = {
    wakeConversation,
    reviewMonitorHold,
    onConversationTurnEnded: (
      listener: (runId: string, caller: string) => void,
    ) => {
      turnEnded = listener;
      return () => undefined;
    },
    setMonitorOutputHeld: (check: typeof outputHeld) => {
      outputHeld = check;
    },
  } as unknown as TeamExecutorService;
  return {
    executor,
    wakeConversation,
    reviewMonitorHold,
    answer: (next: MonitorWake) => {
      answer = next;
    },
    endTurn: () => turnEnded(owner.runId, owner.caller),
    held: () => outputHeld(owner.runId, owner.caller),
  };
}

describe('MonitorGraphDelivery', () => {
  let registry: MonitorRegistry;
  const writeEnds = vi.fn(async () => undefined);

  beforeEach(() => {
    registry = new MonitorRegistry(new ProcessRegistry());
    writeEnds.mockClear();
  });

  afterEach(async () => {
    registry.stopRun(owner.runId, 'teardown');
    await registry.settled(owner.runId, 5000);
  });

  function delivery(fake: ReturnType<typeof fakeExecutor>): void {
    new MonitorGraphDelivery(registry, fake.executor, {
      writeEnds,
    } as unknown as MonitorRowWriter).onModuleInit();
  }

  it('holds output while the conversation works and wakes it once, merged, when its turn ends', async () => {
    const fake = fakeExecutor();
    delivery(fake);
    registry.start({
      owner,
      command: 'for i in 1 2; do echo $i; sleep 0.3; done',
      description: 'count',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    // Every attempt so far found the conversation busy, so the output waits —
    // and a callee's hold reads it as owed.
    expect(fake.held()).toBe(true);
    const busyAttempts = fake.wakeConversation.mock.calls.length;

    fake.answer('woken');
    fake.endTurn();
    expect(fake.wakeConversation).toHaveBeenCalledTimes(busyAttempts + 1);
    const [runId, caller, prompt, row] =
      fake.wakeConversation.mock.calls.at(-1)!;
    expect([runId, caller]).toEqual(['run-1', 'dev']);
    expect(prompt).toContain('monitor="m1"');
    expect(row).toMatchObject({
      woke: true,
      monitors: [{ id: 'm1', event: 'end', lines: ['1', '2'] }],
    });
    expect(fake.held()).toBe(false);
  });

  it('records the end of output no turn can take', async () => {
    const fake = fakeExecutor();
    fake.answer('refused');
    delivery(fake);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    expect(writeEnds).toHaveBeenCalledWith(
      { runId: 'run-1', memberId: 'dev', callId: null, conversationId: null },
      [expect.objectContaining({ id: 'm1', end: { kind: 'exit', code: 0 } })],
    );
  });

  it('records the end of a wake the run dropped after taking it', async () => {
    const fake = fakeExecutor();
    fake.answer('woken');
    delivery(fake);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    const call = fake.wakeConversation.mock.calls.find(([, , , row]) =>
      (row.monitors ?? []).some((entry) => entry.event === 'end'),
    );
    expect(writeEnds).not.toHaveBeenCalled();
    // The run was stopped before the turn could start.
    call![4]!(false);
    expect(writeEnds).toHaveBeenCalledWith(
      { runId: 'run-1', memberId: 'dev', callId: null, conversationId: null },
      [expect.objectContaining({ id: 'm1', end: { kind: 'exit', code: 0 } })],
    );
  });

  it("holds output again when a user's message started the run's next pass first, and wakes that pass's turn with it", async () => {
    const fake = fakeExecutor();
    fake.answer('woken');
    delivery(fake);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    const calls = fake.wakeConversation.mock.calls.length;
    const handBack = fake.wakeConversation.mock.calls.at(-1)![4]!;
    handBack(true);
    expect(writeEnds).not.toHaveBeenCalled();
    expect(fake.held()).toBe(true);

    fake.endTurn();
    expect(fake.wakeConversation).toHaveBeenCalledTimes(calls + 1);
    expect(fake.wakeConversation.mock.calls.at(-1)![3]).toMatchObject({
      monitors: [{ id: 'm1', event: 'end' }],
    });
  });

  it('lets a held callee settle when its monitor ends unannounced', async () => {
    const fake = fakeExecutor();
    delivery(fake);
    registry.start({
      owner,
      command: 'while true; do sleep 1; done',
      description: 'loop',
      timeoutMs: 60_000,
    });
    registry.stop(owner.runId, 'm1', 'agent');
    await registry.settled(owner.runId, 5000);
    expect(fake.reviewMonitorHold).toHaveBeenCalledWith('run-1', 'dev');
    expect(fake.held()).toBe(false);
  });
});
