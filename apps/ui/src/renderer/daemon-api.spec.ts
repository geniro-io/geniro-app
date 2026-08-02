import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import {
  createDaemonApis,
  daemonErrorStatus,
  REQUEST_TIMEOUT_MS,
} from './daemon-api';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 8123,
  token: 'tok',
  version: '1',
};

function stubFetch(response: Partial<Response> & { ok: boolean }) {
  const fetchMock = vi.fn().mockResolvedValue({
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(''),
    clone() {
      return this;
    },
    status: 200,
    ...response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const initOf = (fetchMock: ReturnType<typeof stubFetch>): RequestInit =>
  fetchMock.mock.calls[0]?.[1] as RequestInit;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDaemonApis', () => {
  it('sends the bearer token and a JSON body to the daemon base URL', async () => {
    const fetchMock = stubFetch({
      ok: true,
      json: () => Promise.resolve({ id: 'x' }),
    });

    const run = await createDaemonApis(handle).chats.createChat({
      createChatDto: { agentKind: 'claude', cwd: '/w' },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8123/v1/chats');
    const init = initOf(fetchMock);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ agentKind: 'claude', cwd: '/w' }));
    expect(run).toEqual({ id: 'x' });
  });

  it('sends a bodyless POST WITHOUT a content-type header', async () => {
    // The cancel routes are bodyless POSTs; an application/json claim with an
    // empty body is rejected by Fastify (FST_ERR_CTP_EMPTY_JSON_BODY), which
    // broke Stop for chats and workflow runs alike.
    const fetchMock = stubFetch({ ok: true });

    await createDaemonApis(handle).chats.cancelChat({ runId: 'r1' });

    const init = initOf(fetchMock);
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('puts a query parameter on the URL', async () => {
    const fetchMock = stubFetch({ ok: true, json: () => Promise.resolve([]) });

    await createDaemonApis(handle).chats.listRunItems({
      runId: 'r1',
      afterSeq: 7,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:8123/v1/chats/r1/items?afterSeq=7',
    );
  });

  it('throws the uniform error shape with the response detail', async () => {
    stubFetch({
      ok: false,
      status: 400,
      text: () => Promise.resolve('TERMINAL_UNSUPPORTED'),
    });

    // This exact format is load-bearing: the renderer surfaces it verbatim and
    // Chats' 404-detection parses the "(status)" segment.
    await expect(
      createDaemonApis(handle).terminals.createTerminal({
        createTerminalDto: { runId: 'r1' },
      }),
    ).rejects.toThrow(
      'daemon POST /v1/terminals failed (400): TERMINAL_UNSUPPORTED',
    );
  });

  it('omits the detail suffix when the error body is unreadable', async () => {
    stubFetch({
      ok: false,
      status: 502,
      text: () => Promise.reject(new Error('stream gone')),
    });

    await expect(
      createDaemonApis(handle).workflows.listWorkflows(),
    ).rejects.toThrow(/daemon GET \/v1\/workflows failed \(502\)$/);
  });

  it('names the query string in the error route, not just the path', async () => {
    stubFetch({ ok: false, status: 404, text: () => Promise.resolve('') });

    await expect(
      createDaemonApis(handle).chats.listRunItems({ runId: 'r1', afterSeq: 3 }),
    ).rejects.toThrow('daemon GET /v1/chats/r1/items?afterSeq=3 failed (404)');
  });

  it('bounds every request with an abort timeout — a wedged daemon route must not hang its renderer action forever', async () => {
    const fetchMock = stubFetch({ ok: true, json: () => Promise.resolve([]) });

    await createDaemonApis(handle).workflows.listWorkflows();

    expect(initOf(fetchMock).signal).toBeInstanceOf(AbortSignal);
    // The ceiling stays sane for a local daemon: generous enough for a slow
    // cold route, far below the old forever.
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe('daemonErrorStatus', () => {
  it('reads the status out of an error the transport itself produced', async () => {
    // Not a hand-written string: the parser is pinned against the real
    // middleware's output, so a change to that format fails HERE rather than
    // silently turning every 404 into "unknown" in the UI.
    stubFetch({
      ok: false,
      status: 404,
      text: () => Promise.resolve('WORKFLOW_NOT_FOUND'),
    });

    const err = await createDaemonApis(handle)
      .workflows.getWorkflow({ slug: 'gone' })
      .catch((caught: unknown) => caught);

    expect(daemonErrorStatus(err)).toBe(404);
  });

  it('is null for anything that is not a daemon response error', async () => {
    // A timeout, an abort, a thrown string — none of them carry a status, and
    // reporting one would let a caller act on a failure it never diagnosed.
    expect(
      daemonErrorStatus(new Error('The operation was aborted')),
    ).toBeNull();
    expect(daemonErrorStatus('failed (404)')).toBeNull();
    expect(daemonErrorStatus(undefined)).toBeNull();
  });
});
