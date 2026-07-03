import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { TerminalClient } from './terminal-client';

// A fake Socket.IO socket whose handlers the test drives directly. vi.hoisted
// so the vi.mock factory can close over it.
const mocks = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const emit = vi.fn();
  const close = vi.fn();
  const socket = {
    on: (event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    },
    emit,
    close,
  };
  return { handlers, emit, close, io: vi.fn(() => socket) };
});

vi.mock('socket.io-client', () => ({ io: mocks.io }));

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
};

beforeEach(() => {
  mocks.emit.mockClear();
  mocks.close.mockClear();
  mocks.io.mockClear();
  for (const key of Object.keys(mocks.handlers)) {
    delete mocks.handlers[key];
  }
});

describe('TerminalClient', () => {
  it('connects to the /terminals namespace on the shared /ws path with the token', () => {
    new TerminalClient(handle, 't-1', {}).connect();

    expect(mocks.io).toHaveBeenCalledWith(
      'http://127.0.0.1:8123/terminals',
      expect.objectContaining({
        path: '/ws',
        auth: { token: 'tok' },
      }),
    );
  });

  it('re-attaches on every connect and replays the snapshot', () => {
    const snapshots: string[] = [];
    const client = new TerminalClient(handle, 't-1', {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
    });
    client.connect();

    mocks.handlers.connect?.();
    expect(mocks.emit).toHaveBeenCalledWith('attach', { terminalId: 't-1' });
    mocks.handlers.attached?.({ terminalId: 't-1', snapshot: 'replay' });
    // A reconnect attaches again — the room membership was lost with the socket.
    mocks.handlers.connect?.();
    mocks.handlers.attached?.({ terminalId: 't-1', snapshot: 'replay-2' });

    expect(
      mocks.emit.mock.calls.filter(([event]) => event === 'attach'),
    ).toHaveLength(2);
    expect(snapshots).toEqual(['replay', 'replay-2']);
  });

  it('routes data and exit for its own terminal only', () => {
    const data: string[] = [];
    const exits: (number | null)[] = [];
    const client = new TerminalClient(handle, 't-1', {
      onData: (d) => data.push(d),
      onExit: (code) => exits.push(code),
    });
    client.connect();

    mocks.handlers.terminal_data?.({ terminalId: 't-1', data: 'bytes' });
    mocks.handlers.terminal_data?.({ terminalId: 'other', data: 'not-mine' });
    mocks.handlers.terminal_data?.({ terminalId: 't-1', data: 42 });
    mocks.handlers.terminal_exit?.({ terminalId: 't-1', exitCode: 0 });

    expect(data).toEqual(['bytes']);
    expect(exits).toEqual([0]);
  });

  it('fires onGone (not onSnapshot) when the attach reply carries an error', () => {
    const snapshots: string[] = [];
    let gone = 0;
    const client = new TerminalClient(handle, 't-1', {
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onGone: () => {
        gone += 1;
      },
    });
    client.connect();

    mocks.handlers.attached?.({
      terminalId: 't-1',
      error: 'TERMINAL_NOT_FOUND',
    });
    // An error reply for ANOTHER terminal is filtered out like any other event.
    mocks.handlers.attached?.({
      terminalId: 'other',
      error: 'TERMINAL_NOT_FOUND',
    });

    expect(gone).toBe(1);
    expect(snapshots).toEqual([]);
  });

  it('sends input and resize with the terminal id, detaches on close', () => {
    const client = new TerminalClient(handle, 't-1', {});
    client.connect();

    client.input('ls\r');
    client.resize(120, 40);
    client.close();

    expect(mocks.emit).toHaveBeenCalledWith('input', {
      terminalId: 't-1',
      data: 'ls\r',
    });
    expect(mocks.emit).toHaveBeenCalledWith('resize', {
      terminalId: 't-1',
      cols: 120,
      rows: 40,
    });
    expect(mocks.emit).toHaveBeenCalledWith('detach', { terminalId: 't-1' });
    expect(mocks.close).toHaveBeenCalled();
  });
});
