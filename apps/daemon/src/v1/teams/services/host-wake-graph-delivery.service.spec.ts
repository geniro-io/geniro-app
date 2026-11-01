import { describe, expect, it, vi } from 'vitest';

import type { HostWake } from '../../agents/chat.types';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import type {
  GraphExecutorService,
  MonitorWake,
} from './graph-executor.service';
import { HostWakeGraphDelivery } from './host-wake-graph-delivery.service';

function wake(
  onDelivered = vi.fn(),
  conversationId: string | null = null,
): HostWake {
  return {
    key: 'share:s1',
    owner: {
      runId: 'run-1',
      nodeId: 'manager',
      conversationId,
      caller:
        conversationId === null ? 'manager' : `manager::${conversationId}`,
      target: 'team',
    },
    prompt: '[geniro] Shared link: https://x.example/a#k=KEY',
    note: '[geniro] Shared link: https://x.example/a#k=KEY',
    row: {
      severity: 'info',
      message: 'Shared "Report"',
      shares: [{ shareId: 's1', title: 'Report', outcome: 'shared' }],
      woke: true,
    },
    onDelivered,
  };
}

function harness() {
  let answer: MonitorWake = 'busy';
  let turnEnded: (runId: string, caller: string) => void = () => undefined;
  const wakeConversation = vi.fn<GraphExecutorService['wakeConversation']>(
    () => answer,
  );
  const executor = {
    wakeConversation,
    onConversationTurnEnded: (
      listener: (runId: string, caller: string) => void,
    ) => {
      turnEnded = listener;
      return () => undefined;
    },
  } as unknown as GraphExecutorService;
  const oweKeyNote = vi.fn(() => true);
  const bus = new HostWakeBus();
  new HostWakeGraphDelivery(bus, executor, {
    oweKeyNote,
  } as unknown as AgentSessionRegistry).onModuleInit();
  return {
    bus,
    wakeConversation,
    oweKeyNote,
    answer: (next: MonitorWake) => {
      answer = next;
    },
    endTurn: (caller = 'manager') => turnEnded('run-1', caller),
  };
}

describe('HostWakeGraphDelivery', () => {
  it('wakes the conversation as a host turn, never counted as a monitor’s', () => {
    const h = harness();
    h.answer('woken');

    h.bus.publish(wake());

    const call = h.wakeConversation.mock.calls[0];
    expect(call?.slice(0, 2)).toEqual(['run-1', 'manager']);
    expect(call?.[5]).toBe('host');
  });

  it('joins the wakes held for one conversation into one turn, saying a row message they share once', () => {
    const h = harness();
    const second = { ...wake(), key: 'share:s2', prompt: 'second' };
    h.bus.publish(wake());
    h.bus.publish(second);
    h.answer('woken');
    h.endTurn();

    const call = h.wakeConversation.mock.calls.at(-1);
    expect(call?.[2]).toBe(`${wake().prompt}\n\nsecond`);
    expect(call?.[3].message).toBe('Shared "Report"');
  });

  it('holds the wake while the conversation works and sends it when its turn ends', () => {
    const h = harness();
    h.bus.publish(wake());
    expect(h.wakeConversation).toHaveBeenCalledTimes(1);

    h.answer('woken');
    h.endTurn();

    expect(h.wakeConversation).toHaveBeenCalledTimes(2);
  });

  it('is told the agent got it only when the turn it started has ended', () => {
    const h = harness();
    h.answer('woken');
    const delivered = vi.fn();
    h.bus.publish(wake(delivered));
    expect(delivered).not.toHaveBeenCalled();

    h.endTurn();

    expect(delivered).toHaveBeenCalledTimes(1);
    expect(h.wakeConversation).toHaveBeenCalledTimes(1);
  });

  it('owes the note, and settles the wake, when no turn can take it — a stopped run, a callee whose call settled', () => {
    const h = harness();
    h.answer('refused');
    const delivered = vi.fn();

    h.bus.publish(wake(delivered, 'call-1'));

    expect(h.oweKeyNote).toHaveBeenCalledWith(
      expect.stringContaining('call-1'),
      expect.stringContaining('Shared link:'),
    );
    // Owed is the wake's last attempt, so it is settled: no boot re-sends it.
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('a wake dropped before its turn started is held again for the next pass, or owed when the run stopped', () => {
    const h = harness();
    h.answer('woken');
    h.bus.publish(wake());
    const dropped = h.wakeConversation.mock.calls[0]?.[4];

    dropped?.(true);
    h.endTurn();
    expect(h.wakeConversation).toHaveBeenCalledTimes(2);

    h.wakeConversation.mock.calls[1]?.[4]?.(false);
    expect(h.oweKeyNote).toHaveBeenCalledTimes(1);
  });

  it('leaves the wake owed when its note could not be kept — the daemon is shutting down', () => {
    const h = harness();
    h.oweKeyNote.mockReturnValue(false);
    h.answer('refused');
    const delivered = vi.fn();

    h.bus.publish(wake(delivered));

    expect(h.oweKeyNote).toHaveBeenCalledTimes(1);
    expect(delivered).not.toHaveBeenCalled();
  });

  it('ignores a chat’s wake', () => {
    const h = harness();
    const w = wake();
    h.bus.publish({ ...w, owner: { ...w.owner, target: 'chat' } });

    expect(h.wakeConversation).not.toHaveBeenCalled();
  });
});
