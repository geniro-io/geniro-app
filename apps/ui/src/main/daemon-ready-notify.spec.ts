import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { IPC } from '../shared/contracts';
import { notifyDaemonReady, type NotifyTarget } from './daemon-ready-notify';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 4870,
  token: 'tok',
  version: '1',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifyDaemonReady', () => {
  it('sends the handle to a live window', () => {
    const send = vi.fn();
    const window = {
      isDestroyed: () => false,
      webContents: { send },
    } as unknown as NotifyTarget;

    notifyDaemonReady(window, handle);

    expect(send).toHaveBeenCalledWith(IPC.onDaemonRestarted, handle);
  });

  it('skips a destroyed window and a null ref without touching webContents', () => {
    const send = vi.fn();
    const destroyed = {
      isDestroyed: () => true,
      webContents: { send },
    } as unknown as NotifyTarget;

    notifyDaemonReady(destroyed, handle);
    notifyDaemonReady(null, handle);

    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a send() into the destruction gap — never a throw up the daemon-start chain', () => {
    // isDestroyed can race the actual teardown: the guard passes, the send
    // throws. A throw here would land in supervisor.start()'s catch and
    // mislog a healthy boot as "daemon failed to start".
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error('Object has been destroyed');
        },
      },
    } as unknown as NotifyTarget;

    expect(() => notifyDaemonReady(window, handle)).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      '[ui] daemon-ready notify failed:',
      expect.any(Error),
    );
  });
});
