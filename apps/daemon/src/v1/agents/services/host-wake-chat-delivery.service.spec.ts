import { ConflictException } from '@packages/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostWake } from '../chat.types';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { ChatService } from './chat.service';
import { HostWakeBus } from './host-wake.bus';
import {
  HOST_WAKE_SEND_ATTEMPTS,
  HOST_WAKE_SEND_RETRY_MS,
  HostWakeChatDelivery,
} from './host-wake-chat-delivery.service';

type Send = ChatService['sendMessage'];

const LINK = 'https://pages.example.com/geniro/abc/index.html#k=SECRETKEY';

function wake(onDelivered = vi.fn(), key = 'share:s1'): HostWake {
  return {
    key,
    owner: {
      runId: 'run-1',
      nodeId: 'agent',
      conversationId: null,
      caller: 'agent',
      target: 'chat',
    },
    prompt: `[geniro] Shared link: ${LINK}`,
    note: `[geniro] Shared link: ${LINK}`,
    row: {
      severity: 'info',
      message:
        'Shared "Report" once you signed in — the agent was sent the link.',
      shares: [{ shareId: 's1', title: 'Report', outcome: 'shared' }],
      woke: true,
    },
    onDelivered,
  };
}

function harness() {
  let hold: 'wait' | 'closing' | null = null;
  let settled: (runId: string) => void = () => undefined;
  let stopped: (runId: string) => void = () => undefined;
  const sendMessage = vi.fn<Send>(
    async () => ({}) as Awaited<ReturnType<Send>>,
  );
  const chats = {
    hostTurnHold: () => hold,
    onTurnSettled: (listener: (runId: string) => void) => {
      settled = listener;
      return () => undefined;
    },
    onStopped: (listener: (runId: string) => void) => {
      stopped = listener;
      return () => undefined;
    },
    sendMessage,
  } as unknown as ChatService;
  const oweKeyNote = vi.fn(() => true);
  const bus = new HostWakeBus();
  const delivery = new HostWakeChatDelivery(bus, chats, {
    oweKeyNote,
  } as unknown as AgentSessionRegistry);
  delivery.onModuleInit();
  return {
    bus,
    delivery,
    sendMessage,
    oweKeyNote,
    setHold: (next: typeof hold) => {
      hold = next;
    },
    settle: () => settled('run-1'),
    stop: () => stopped('run-1'),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HostWakeChatDelivery', () => {
  it('sends nothing before the daemon listens, then opens a host turn on the wake’s row', async () => {
    const h = harness();
    const delivered = vi.fn();
    h.bus.publish(wake(delivered));
    await Promise.resolve();
    expect(h.sendMessage).not.toHaveBeenCalled();

    h.delivery.startDelivering();

    await expect.poll(() => delivered.mock.calls.length).toBe(1);
    const [runId, prompt, , options] = h.sendMessage.mock.calls[0] ?? [];
    expect(runId).toBe('run-1');
    expect(prompt).toContain(`Shared link: ${LINK}`);
    expect(options).toMatchObject({ ownTurn: true });
    expect(JSON.stringify(options?.hostRow)).not.toContain('#k=');
  });

  it('holds a wake while the agent works and delivers it when the turn settles', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.setHold('wait');
    const delivered = vi.fn();

    h.bus.publish(wake(delivered));
    await Promise.resolve();
    expect(h.sendMessage).not.toHaveBeenCalled();

    h.setHold(null);
    h.settle();
    await expect.poll(() => delivered.mock.calls.length).toBe(1);
  });

  it('drops a held wake withdrawn while it waited — neither sent nor owed, and never settled', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.setHold('wait');
    const delivered = vi.fn();
    let withdrawn = false;
    h.bus.publish({ ...wake(delivered), withdrawn: () => withdrawn });
    await Promise.resolve();

    withdrawn = true;
    h.setHold(null);
    h.settle();
    h.stop();
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.oweKeyNote).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
  });

  it('holds it again when a turn claimed the chat first (RUN_BUSY), and is told only once it went out', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_BUSY', 'busy'),
    );
    const delivered = vi.fn();

    h.bus.publish(wake(delivered));
    await expect.poll(() => h.sendMessage.mock.calls.length).toBe(1);
    await Promise.resolve();
    expect(delivered).not.toHaveBeenCalled();

    h.settle();
    await expect.poll(() => delivered.mock.calls.length).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.oweKeyNote).not.toHaveBeenCalled();
  });

  it('retries another failure a few times, then owes the note to the chat’s next turn', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.delivery.startDelivering();
    h.sendMessage.mockRejectedValue(new Error('folder gone'));
    const delivered = vi.fn();

    h.bus.publish(wake(delivered));
    for (let attempt = 1; attempt < HOST_WAKE_SEND_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(HOST_WAKE_SEND_RETRY_MS);
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(h.sendMessage).toHaveBeenCalledTimes(HOST_WAKE_SEND_ATTEMPTS);
    expect(h.oweKeyNote).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining(`Shared link: ${LINK}`),
    );
    // The owed note is the wake's last attempt: it is settled, so a boot does
    // not send it again.
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('owes the note without a turn when the chat is being archived or deleted', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.setHold('closing');
    const delivered = vi.fn();

    h.bus.publish(wake(delivered));
    await Promise.resolve();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.oweKeyNote).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('never retries a send that failed after its row was written — that would show the link twice', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.sendMessage.mockImplementationOnce(
      async (_runId, _text, _images, options) => {
        options?.onHostRowWritten?.();
        throw new Error('the model refused');
      },
    );

    h.bus.publish(wake());

    await expect.poll(() => h.oweKeyNote.mock.calls.length).toBe(1);
    h.settle();
    await Promise.resolve();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('counts a Stop against a send still in flight even after an overlapping send for the same chat finished', async () => {
    const h = harness();
    h.delivery.startDelivering();
    let fail!: (err: Error) => void;
    h.sendMessage
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockRejectedValueOnce(new ConflictException('RUN_BUSY', 'busy'));

    h.bus.publish(wake(vi.fn(), 'share:s1'));
    await expect.poll(() => h.sendMessage.mock.calls.length).toBe(1);
    // A second wake overlaps the first send and is refused RUN_BUSY.
    h.bus.publish(wake(vi.fn(), 'share:s2'));
    await expect.poll(() => h.sendMessage.mock.calls.length).toBe(2);
    await Promise.resolve();
    h.stop();
    fail(new Error('turn cancelled'));

    await expect.poll(() => h.oweKeyNote.mock.calls.length).toBeGreaterThan(0);
    h.settle();
    await Promise.resolve();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('a Stop pressed while the wake is being sent turns it into a note, never a retry', async () => {
    const h = harness();
    h.delivery.startDelivering();
    let fail!: (err: Error) => void;
    h.sendMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );

    h.bus.publish(wake());
    await expect.poll(() => h.sendMessage.mock.calls.length).toBe(1);
    h.stop();
    fail(new Error('turn cancelled'));

    await expect.poll(() => h.oweKeyNote.mock.calls.length).toBe(1);
    h.settle();
    await Promise.resolve();
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('owes an archived chat the note instead of starting a turn', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_ARCHIVED', 'archived'),
    );

    h.bus.publish(wake());

    await expect.poll(() => h.oweKeyNote.mock.calls.length).toBe(1);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('starts no turn after the user’s Stop: what it held becomes a note', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.setHold('wait');
    h.bus.publish(wake());
    await Promise.resolve();

    h.stop();
    h.setHold(null);
    h.settle();
    await Promise.resolve();

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.oweKeyNote).toHaveBeenCalledTimes(1);
  });

  it('a newer wake about the same share replaces the one held, and two shares go out in one turn', async () => {
    const h = harness();
    h.delivery.startDelivering();
    h.setHold('wait');
    h.bus.publish(wake(vi.fn(), 'share:s1'));
    h.bus.publish(wake(vi.fn(), 'share:s1'));
    h.bus.publish(wake(vi.fn(), 'share:s2'));

    h.setHold(null);
    h.settle();

    await expect.poll(() => h.sendMessage.mock.calls.length).toBe(1);
    const options = h.sendMessage.mock.calls[0]?.[3];
    expect(options?.hostRow?.shares).toHaveLength(2);
  });

  it('ignores a wake for a workflow conversation', async () => {
    const h = harness();
    h.delivery.startDelivering();
    const w = wake();
    h.bus.publish({ ...w, owner: { ...w.owner, target: 'workflow' } });
    await Promise.resolve();

    expect(h.sendMessage).not.toHaveBeenCalled();
  });
});
