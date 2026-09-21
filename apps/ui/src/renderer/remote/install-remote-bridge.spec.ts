// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../shared/contracts';
import { REMOTE_ROUTE_BRIDGE } from '../../shared/remote';
import {
  installRemoteBridge,
  RemoteChannelDeniedError,
} from './install-remote-bridge';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('installRemoteBridge', () => {
  afterEach(() => {
    delete (window as { geniro?: unknown }).geniro;
    vi.unstubAllGlobals();
  });

  // The shim DEFINES `window.geniro`, so a live `window.geniro === undefined`
  // reading of "am I in a browser" answers its own question away: after this
  // call it would say "not remote" on a phone, the pairing screen would never
  // render, and every bridge call would 401 with nothing on screen saying why.
  it('does not make isRemoteRuntime() answer false by installing the bridge', async () => {
    const { isRemoteRuntime } = await import('./remote-session');
    expect(isRemoteRuntime()).toBe(true);

    installRemoteBridge();

    expect(window.geniro).toBeDefined();
    expect(isRemoteRuntime()).toBe(true);
  });

  it('leaves a real preload bridge alone', () => {
    const marker = {} as unknown as typeof window.geniro;
    window.geniro = marker;

    installRemoteBridge();

    expect(window.geniro).toBe(marker);
  });

  it('installs a shim that posts {channel, args} and resolves the reply value', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { value: { onboardingComplete: true } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    installRemoteBridge();
    const result = await window.geniro.getStatus();

    expect(result).toEqual({ onboardingComplete: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REMOTE_ROUTE_BRIDGE);
    expect(init.credentials).toBe('same-origin');
    expect(JSON.parse(init.body as string)).toEqual({
      channel: IPC.getStatus,
      args: [],
    });
  });

  it('forwards call arguments verbatim, under the SAME channel name the real preload dispatches on', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { value: null }));
    vi.stubGlobal('fetch', fetchMock);

    installRemoteBridge();
    await window.geniro.pickProjectFolder('/Users/me/project');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      channel: IPC.pickProjectFolder,
      args: ['/Users/me/project'],
    });
  });

  it('rejects with a RemoteChannelDeniedError on a refusal, carrying the channel and reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          refusal: {
            code: 'REMOTE_CHANNEL_DENIED',
            channel: IPC.toggleDevTools,
            reason: 'DevTools has no remote answer.',
          },
        }),
      ),
    );

    installRemoteBridge();
    const call = window.geniro.toggleDevTools();

    await expect(call).rejects.toBeInstanceOf(RemoteChannelDeniedError);
    await expect(call).rejects.toMatchObject({
      channel: IPC.toggleDevTools,
      reason: 'DevTools has no remote answer.',
    });
  });

  it('rejects with the reply’s own error message on a native failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { error: 'disk is full' })),
    );

    installRemoteBridge();
    await expect(window.geniro.pickAgentBinary()).rejects.toThrow(
      'disk is full',
    );
  });

  it('rejects on a transport failure — a DIFFERENT error from a refusal, distinguishable by instanceof', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, {})));

    installRemoteBridge();
    await expect(window.geniro.detectClis()).rejects.not.toBeInstanceOf(
      RemoteChannelDeniedError,
    );
  });

  it('gives every push subscription a working no-op unsubscribe rather than throwing', () => {
    vi.stubGlobal('fetch', vi.fn());
    installRemoteBridge();

    const unsubscribe = window.geniro.onDaemonRestarted(() => undefined);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('answers filePath with null — a browser never exposes a File’s real filesystem path', () => {
    installRemoteBridge();

    const file = new File(['x'], 'note.txt');
    expect(window.geniro.filePath(file)).toBeNull();
  });
});
