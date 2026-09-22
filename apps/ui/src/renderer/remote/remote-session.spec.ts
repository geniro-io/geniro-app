// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REMOTE_CSRF_HEADER,
  REMOTE_ROUTE_PAIR,
  REMOTE_ROUTE_SESSION,
} from '../../shared/remote';
import {
  isRemoteRuntime,
  readSession,
  submitPairingCode,
} from './remote-session';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('isRemoteRuntime', () => {
  afterEach(() => {
    delete (window as { geniro?: unknown }).geniro;
  });

  it('is true when nothing has installed a preload bridge', () => {
    expect(isRemoteRuntime()).toBe(true);
  });

  // The answer is fixed when the module is evaluated, which is what makes it
  // survive the shim installing a bridge a moment later — a live read would
  // flip to false there and the pairing screen would never render.
  it('does not change when a bridge appears after the module was evaluated', () => {
    (window as { geniro?: unknown }).geniro = {};
    expect(isRemoteRuntime()).toBe(true);
  });

  it('is false when a preload had already put a bridge on window', async () => {
    (window as { geniro?: unknown }).geniro = {};
    // Re-evaluated with the bridge ALREADY present, which is the ordering a
    // real preload produces: it runs long before any renderer module.
    vi.resetModules();
    const fresh = await import('./remote-session');

    expect(fresh.isRemoteRuntime()).toBe(false);
  });
});

describe('readSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the paired session the gateway reports', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { paired: true, deviceId: 'device-1' }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(readSession()).resolves.toEqual({
      paired: true,
      deviceId: 'device-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(REMOTE_ROUTE_SESSION, {
      credentials: 'same-origin',
    });
  });

  it('answers unpaired on a non-2xx reply, never throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));

    await expect(readSession()).resolves.toEqual({
      paired: false,
      deviceId: null,
    });
  });

  it('answers unpaired when the gateway cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    await expect(readSession()).resolves.toEqual({
      paired: false,
      deviceId: null,
    });
  });
});

describe('submitPairingCode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the code with the CSRF header and reports success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitPairingCode('123456')).resolves.toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(REMOTE_ROUTE_PAIR);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(
      (init.headers as Record<string, string>)[REMOTE_CSRF_HEADER],
    ).toBeDefined();
    expect(init.body).toBe(JSON.stringify({ code: '123456' }));
  });

  it('surfaces the server’s own refusal wording for an incorrect code, never inventing one', async () => {
    // The body shape here is what `remote-routes.ts`'s `pair()` actually
    // emits on the 'incorrect' outcome — a `PairingRefusal` with no
    // `retryAfterMs`. A body shaped like anything else would be testing a
    // route this code does not call.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(401, {
          message: 'Incorrect code.',
        }),
      ),
    );

    await expect(submitPairingCode('000000')).resolves.toEqual({
      ok: false,
      message: 'Incorrect code.',
    });
  });

  it('surfaces the server’s own refusal wording AND retryAfterMs for a lockout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(429, {
          message: 'Too many attempts — try again later.',
          retryAfterMs: 240_000,
        }),
      ),
    );

    await expect(submitPairingCode('000000')).resolves.toEqual({
      ok: false,
      message: 'Too many attempts — try again later.',
      retryAfterMs: 240_000,
    });
  });

  it('falls back to a transport message when the gateway cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    );

    const result = await submitPairingCode('123456');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });

  it('falls back to a transport message when the refusal body has no message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(500, {})));

    const result = await submitPairingCode('123456');
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });
});
