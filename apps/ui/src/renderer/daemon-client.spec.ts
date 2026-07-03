import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatItem, DaemonHandle } from '../shared/contracts';
import { DaemonClient } from './daemon-client';

// A fake Socket.IO socket whose 'connect' handler and onAny dispatcher the test
// can drive directly. vi.hoisted so the vi.mock factory can close over it.
const mocks = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const ref: { any: ((event: string, data: unknown) => void) | null } = {
    any: null,
  };
  const emit = vi.fn();
  const close = vi.fn();
  const socket = {
    on: (event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    },
    onAny: (h: (event: string, data: unknown) => void) => {
      ref.any = h;
    },
    emit,
    close,
  };
  return { handlers, ref, emit, close, io: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
};

function fireConnect(): void {
  mocks.handlers.connect?.();
}

beforeEach(() => {
  mocks.emit.mockClear();
  mocks.close.mockClear();
  mocks.io.mockClear();
  mocks.ref.any = null;
  for (const key of Object.keys(mocks.handlers)) {
    delete mocks.handlers[key];
  }
});

describe('DaemonClient', () => {
  it('fires onReconnect only on a re-connect, and re-joins the active room each connect', () => {
    const client = new DaemonClient(handle, {});
    const reconnects: number[] = [];
    client.onReconnect(() => reconnects.push(1));
    client.connect();
    client.joinRun('r1');

    // First connect is NOT a reconnect: no onReconnect, but the active room is
    // (re-)joined so live items resume.
    mocks.emit.mockClear();
    fireConnect();
    expect(reconnects).toHaveLength(0);
    expect(mocks.emit).toHaveBeenCalledWith('join', { runId: 'r1' });

    // Second connect IS a reconnect: onReconnect fires and the room is re-joined.
    mocks.emit.mockClear();
    fireConnect();
    expect(reconnects).toHaveLength(1);
    expect(mocks.emit).toHaveBeenCalledWith('join', { runId: 'r1' });
  });

  it('routes only `item` events from onAny to onItem subscribers', () => {
    const client = new DaemonClient(handle, {});
    const items: ChatItem[] = [];
    client.onItem((i) => items.push(i));
    client.connect();

    const item: ChatItem = {
      id: 'i0',
      runId: 'r1',
      nodeId: null,
      seq: 0,
      kind: 'message',
      role: 'assistant',
      payload: { text: 'hi' },
      createdAt: 'now',
    };
    mocks.ref.any?.('item', item);
    mocks.ref.any?.('other', { x: 1 });

    expect(items).toEqual([item]);
  });

  it('leaveRun clears the active room so a later reconnect does not rejoin it', () => {
    const client = new DaemonClient(handle, {});
    client.connect();
    client.joinRun('r1');
    client.leaveRun('r1');

    mocks.emit.mockClear();
    fireConnect();
    expect(mocks.emit).not.toHaveBeenCalledWith('join', { runId: 'r1' });
  });
});
