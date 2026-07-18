import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { DaemonRestApi } from './daemon-rest';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
};

/** Concrete subclass exposing the protected transport for direct testing. */
class ProbeApi extends DaemonRestApi {
  call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.request(method, path, body);
  }
}

function stubFetch(response: Partial<Response> & { ok: boolean }) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    status: 200,
    ...response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DaemonRestApi', () => {
  it('sends the bearer token and a JSON body to the daemon base URL', async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: () => Promise.resolve({ id: 'x' }),
    });
    const api = new ProbeApi(handle);

    const result = await api.call('POST', '/v1/things', { a: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8123/v1/things',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer tok',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({ a: 1 }),
      }),
    );
    expect(result).toEqual({ id: 'x' });
  });

  it('omits the body for a GET', async () => {
    const fetchMock = stubFetch({ ok: true });
    const api = new ProbeApi(handle);

    await api.call('GET', '/v1/things');

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('sends a bodyless POST WITHOUT a content-type header', async () => {
    // The cancel routes are bodyless POSTs; an application/json claim with an
    // empty body is rejected by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY), which
    // broke Stop for chats and workflow runs alike.
    const fetchMock = stubFetch({ ok: true });
    const api = new ProbeApi(handle);

    await api.call('POST', '/v1/chats/r1/cancel');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ authorization: 'Bearer tok' });
  });

  it('throws the uniform error shape with the response detail', async () => {
    stubFetch({
      ok: false,
      status: 400,
      text: () => Promise.resolve('TERMINAL_UNSUPPORTED'),
    });
    const api = new ProbeApi(handle);

    // This exact format is load-bearing: the renderer surfaces it verbatim and
    // Chats' 404-detection parses the "(status)" segment.
    await expect(api.call('POST', '/v1/terminals')).rejects.toThrow(
      'daemon POST /v1/terminals failed (400): TERMINAL_UNSUPPORTED',
    );
  });

  it('omits the detail suffix when the error body is unreadable', async () => {
    stubFetch({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('stream gone')),
    });
    const api = new ProbeApi(handle);

    await expect(api.call('GET', '/v1/things')).rejects.toThrow(
      /daemon GET \/v1\/things failed \(502\)$/,
    );
  });
});
