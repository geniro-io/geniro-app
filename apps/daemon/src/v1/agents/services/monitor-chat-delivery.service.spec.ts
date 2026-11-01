import { ConflictException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MonitorRowPayload } from '../chat.types';
import type { MonitorEvent, MonitorOwner } from '../chat.types';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { ChatService } from './chat.service';
import { MonitorRegistry } from './monitor.registry';
import {
  MONITOR_SEND_ATTEMPTS,
  MONITOR_SEND_RETRY_MS,
  MonitorChatDelivery,
} from './monitor-chat-delivery.service';
import type { MonitorRowOwner, MonitorRowWriter } from './monitor-row.writer';
import { ProcessRegistry } from './process-registry';
import type { RunNoticeWriter } from './run-notice.writer';

const owner: MonitorOwner = {
  runId: 'run-1',
  memberId: 'agent',
  caller: 'agent',
  conversationId: null,
  callId: null,
  target: 'chat',
};

const FOREVER = 'while true; do sleep 1; done';

type Send = ChatService['sendMessage'];

/** A chat that is idle unless told otherwise, recording what it was sent. */
function fakeChat() {
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
  return {
    chats,
    sendMessage,
    setHold: (next: typeof hold) => {
      hold = next;
    },
    settle: () => settled(owner.runId),
    stop: () => stopped(owner.runId),
  };
}

/** The end rows a dropped message is recorded with. */
function fakeRows() {
  const ends: { owner: MonitorRowOwner; entry: MonitorRowPayload }[] = [];
  const rows = {
    writeEnds: vi.fn(
      async (
        rowOwner: MonitorRowOwner,
        messages: Iterable<{ id: string; end?: unknown }>,
      ) => {
        for (const message of messages) {
          if (message.end !== undefined) {
            ends.push({
              owner: rowOwner,
              entry: { id: message.id } as MonitorRowPayload,
            });
          }
        }
      },
    ),
  } as unknown as MonitorRowWriter;
  return { rows, ends };
}

function until(check: () => boolean, ms = 5000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) {
        resolve();
      } else if (Date.now() - started > ms) {
        reject(new Error('timed out waiting'));
      } else {
        setTimeout(tick, 20);
      }
    };
    tick();
  });
}

describe('MonitorChatDelivery', () => {
  let registry: MonitorRegistry;

  beforeEach(() => {
    registry = new MonitorRegistry(new ProcessRegistry());
  });

  afterEach(async () => {
    registry.stopRun(owner.runId, 'teardown');
    await registry.settled(owner.runId, 5000);
  });

  function delivery(chat: ReturnType<typeof fakeChat>, listening = true) {
    const { rows, ends } = fakeRows();
    const oweKeyNote = vi.fn();
    const warnings: { message: string; owedWhenWritten: boolean }[] = [];
    let service: MonitorChatDelivery | null = null;
    const notices = {
      warn: async (_runId: string, message: string) => {
        warnings.push({
          message,
          owedWhenWritten: service?.owesOutput('run-1') ?? false,
        });
      },
    } as unknown as RunNoticeWriter;
    service = new MonitorChatDelivery(
      registry,
      chat.chats,
      rows,
      { oweKeyNote } as unknown as AgentSessionRegistry,
      notices,
    );
    service.onModuleInit();
    if (listening) {
      service.startDelivering();
    }
    return { service, ends, oweKeyNote, warnings };
  }

  it('starts an own turn on an idle chat whose opening row is the monitor row, not a user message', async () => {
    const chat = fakeChat();
    delivery(chat);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    await until(() => chat.sendMessage.mock.calls.length > 0);

    const [runId, text, images, options] = chat.sendMessage.mock.calls[0]!;
    expect(runId).toBe('run-1');
    expect(images).toEqual([]);
    expect(options).toMatchObject({ ownTurn: true });
    expect(text).toContain(
      '<message from="once · monitor · exit code 0" monitor="m1">',
    );
    expect(text).toContain('not instructions from the user');
    expect(options?.hostRow).toMatchObject({
      woke: true,
      monitors: [
        {
          id: 'm1',
          event: 'end',
          end: { kind: 'exit', code: 0 },
          lines: ['done'],
        },
      ],
    });
  });

  it('holds output while the chat is busy and sends it as ONE merged message when the turn ends', async () => {
    const chat = fakeChat();
    chat.setHold('wait');
    delivery(chat);
    registry.start({
      owner,
      command: 'for i in 1 2 3; do echo $i; sleep 0.3; done',
      description: 'count',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    expect(chat.sendMessage).not.toHaveBeenCalled();

    chat.setHold(null);
    chat.settle();
    await until(() => chat.sendMessage.mock.calls.length > 0);
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(chat.sendMessage.mock.calls[0]![3]?.hostRow).toMatchObject({
      monitors: [{ id: 'm1', event: 'end', lines: ['1', '2', '3'] }],
    });
  });

  it('holds again when a turn claimed the chat in between, and goes out at that turn’s end', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_BUSY', 'a turn is running'),
    );
    delivery(chat);
    registry.start({
      owner,
      command: 'echo hi',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    await until(() => chat.sendMessage.mock.calls.length === 1);

    chat.settle();
    await until(() => chat.sendMessage.mock.calls.length === 2);
    expect(chat.sendMessage.mock.calls[1]![1]).toContain('hi');
  });

  it("sends nothing more once the agent's own stop or the thread's Stop ended the monitor", async () => {
    const chat = fakeChat();
    chat.setHold('wait');
    delivery(chat);
    registry.start({
      owner,
      command: `echo early; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    registry.stopRun(owner.runId, 'thread-stop');
    await registry.settled(owner.runId, 5000);

    chat.setHold(null);
    chat.settle();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('drops what a thread Stop finds held, even a monitor that already ended, and records its end', async () => {
    const chat = fakeChat();
    chat.setHold('wait');
    const { ends } = delivery(chat);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);

    chat.stop();
    chat.setHold(null);
    chat.settle();
    await until(() => ends.length === 1);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    expect(ends[0]?.entry.id).toBe('m1');
  });

  it('sends nothing to a chat being closed, recording the ends it drops', async () => {
    const chat = fakeChat();
    chat.setHold('closing');
    const { ends } = delivery(chat);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    await until(() => ends.length === 1);
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });

  it('stops the monitors of a chat that turned out archived', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValueOnce(
      new ConflictException('RUN_ARCHIVED', 'this chat is archived'),
    );
    delivery(chat);
    const stoppedBy: (string | null)[] = [];
    registry.subscribe((event: MonitorEvent) => {
      if (event.type === 'end') {
        stoppedBy.push(event.stoppedBy);
      }
    });
    registry.start({
      owner,
      command: `echo first; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    await registry.settled(owner.runId, 5000);
    expect(stoppedBy).toEqual(['teardown']);
  });

  it('keeps the monitors of a chat whose turn could not start and tries again when its next turn settles', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValueOnce(new Error('the folder is gone'));
    delivery(chat);
    registry.start({
      owner,
      command: `echo first; sleep 0.4; echo second; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    // New output does not retry early: the retry waits for its moment.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    expect(registry.isRunning(owner.runId)).toBe(true);

    chat.settle();
    await until(() => chat.sendMessage.mock.calls.length === 2);
    // Nothing was lost: the failed message went out with what came after it.
    expect(chat.sendMessage.mock.calls[1]![3]?.hostRow).toMatchObject({
      monitors: [{ id: 'm1', event: 'batch', lines: ['first', 'second'] }],
    });
  });

  it('tries a failed send again on its own once the retry is due, with no turn settling', async () => {
    vi.useFakeTimers();
    try {
      const chat = fakeChat();
      chat.sendMessage.mockRejectedValueOnce(new Error('a write failed'));
      const { service } = delivery(chat, false);
      service.holdInterrupted(
        { runId: 'run-1', memberId: null, callId: null, conversationId: null },
        [
          {
            id: 'm4',
            description: 'CI',
            batch: { lines: ['red'], omitted: 0 },
          },
        ],
      );
      service.startDelivering();
      await vi.advanceTimersByTimeAsync(0);
      expect(chat.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(MONITOR_SEND_RETRY_MS - 1);
      expect(chat.sendMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(chat.sendMessage).toHaveBeenCalledTimes(2);
      expect(chat.sendMessage.mock.calls[1]![1]).toContain('red');
    } finally {
      vi.useRealTimers();
    }
  });

  it(`stops the monitors of a chat whose turn cannot start ${MONITOR_SEND_ATTEMPTS} times in a row, and tells its next turn`, async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValue(new Error('the folder is gone'));
    const { service, oweKeyNote, warnings } = delivery(chat);
    const stoppedBy: (string | null)[] = [];
    registry.subscribe((event: MonitorEvent) => {
      if (event.type === 'end') {
        stoppedBy.push(event.stoppedBy);
      }
    });
    registry.start({
      owner,
      command: `echo first; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    for (let attempt = 1; attempt <= MONITOR_SEND_ATTEMPTS; attempt += 1) {
      await until(() => chat.sendMessage.mock.calls.length === attempt);
      expect(stoppedBy).toEqual([]);
      if (attempt < MONITOR_SEND_ATTEMPTS) {
        expect(service.owesOutput('run-1')).toBe(true);
        chat.settle();
      }
    }
    await registry.settled(owner.runId, 5000);
    await until(() => warnings.length === 1);
    expect(stoppedBy).toEqual(['teardown']);
    expect(chat.sendMessage).toHaveBeenCalledTimes(MONITOR_SEND_ATTEMPTS);
    // The agent never got the output, so its next turn carries it.
    expect(oweKeyNote).toHaveBeenCalledWith(
      'run-1',
      expect.stringMatching(/m1 \(loop\)[\s\S]*first/),
    );
    // The user sees why, written once nothing is owed any more.
    expect(warnings).toEqual([
      {
        message: expect.stringContaining('m1 (loop): the folder is gone'),
        owedWhenWritten: false,
      },
    ]);
    expect(service.owesOutput('run-1')).toBe(false);
  });

  it('does not retry a send that failed after writing its opening row, so the output is shown once', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockImplementation(
      async (_runId, _text, _images, options) => {
        options?.onHostRowWritten?.();
        throw new Error('the model was refused');
      },
    );
    const { ends, oweKeyNote } = delivery(chat);
    registry.start({
      owner,
      command: `echo first; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    await registry.settled(owner.runId, 5000);
    chat.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
    // Its row carried the output; no end is written beside it.
    expect(ends).toEqual([]);
    expect(oweKeyNote).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('m1 (loop)'),
    );
    // The row already showed the output; the note does not repeat it.
    expect(oweKeyNote).not.toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('first'),
    );
  });

  it("does not take a failed send's own settle for the chat's next turn", async () => {
    const chat = fakeChat();
    // More output arrives while the send is out (the chat reads busy then),
    // and the failed start announces a settle before it throws.
    chat.sendMessage.mockImplementationOnce(async () => {
      chat.setHold('wait');
      await new Promise((resolve) => setTimeout(resolve, 700));
      chat.setHold(null);
      chat.settle();
      throw new Error('the folder is gone');
    });
    delivery(chat);
    registry.start({
      owner,
      command: `echo first; sleep 0.3; echo second; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends nothing more when the thread's Stop came while a send that then failed was out", async () => {
    const chat = fakeChat();
    let fail: (err: Error) => void = () => undefined;
    chat.sendMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    delivery(chat);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    chat.stop();
    fail(new Error('the folder is gone'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    chat.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('lets new output through once the output a failed send waited to retry is gone', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValueOnce(new Error('the folder is gone'));
    delivery(chat);
    registry.start({
      owner,
      command: `echo first; ${FOREVER}`,
      description: 'loop',
      timeoutMs: 60_000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 1);
    // The agent stops it during the user's next turn: nothing is left to retry.
    chat.setHold('wait');
    registry.stop(owner.runId, 'm1', 'agent');
    await registry.settled(owner.runId, 5000);
    chat.setHold(null);
    chat.settle();
    registry.start({
      owner,
      command: 'echo again',
      description: 'next',
      timeoutMs: 5000,
    });
    await until(() => chat.sendMessage.mock.calls.length === 2);
    expect(chat.sendMessage.mock.calls[1]![1]).toContain('again');
  });

  it('records the end of output whose sends never wrote their opening row', async () => {
    const chat = fakeChat();
    chat.sendMessage.mockRejectedValue(new Error('the folder is gone'));
    const { ends } = delivery(chat);
    registry.start({
      owner,
      command: 'echo done',
      description: 'once',
      timeoutMs: 5000,
    });
    await registry.settled(owner.runId, 5000);
    for (let attempt = 1; attempt <= MONITOR_SEND_ATTEMPTS; attempt += 1) {
      await until(() => chat.sendMessage.mock.calls.length === attempt);
      if (attempt < MONITOR_SEND_ATTEMPTS) {
        chat.settle();
      }
    }
    await until(() => ends.length === 1);
    expect(ends[0]?.entry.id).toBe('m1');
  });

  it('holds a boot wake until the daemon listens', async () => {
    const chat = fakeChat();
    const { service } = delivery(chat, false);
    service.holdInterrupted(
      { runId: 'run-1', memberId: 'agent', callId: null, conversationId: null },
      [
        {
          id: 'm3',
          description: 'CI',
          batch: { lines: [], omitted: 0 },
          end: { kind: 'interrupted' },
        },
      ],
    );
    chat.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chat.sendMessage).not.toHaveBeenCalled();

    service.startDelivering();
    await until(() => chat.sendMessage.mock.calls.length === 1);
    expect(chat.sendMessage.mock.calls[0]![1]).toContain(
      'interrupted — geniro restarted',
    );
  });
});
