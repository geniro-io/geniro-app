import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { constants } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFetchDispatcher } from './fetch-dispatcher';

const KEY = Symbol.for('undici.globalDispatcher.1');
const KEY_V2 = Symbol.for('undici.globalDispatcher.2');
const DISPATCHER_KEYS = [KEY, KEY_V2];

/** What the native handle answers when macOS refuses `setsockopt(IP_TOS)`. */
const UV_EINVAL = -constants.errno.EINVAL;

interface TcpHandle {
  setTypeOfService(tos: number): number;
}

const handleOf = (socket: Socket): TcpHandle =>
  (socket as unknown as { _handle: TcpHandle })._handle;

const globals = globalThis as unknown as Record<PropertyKey, unknown>;

describe('installFetchDispatcher, against the real bundled fetch', () => {
  let server: Server;
  let url: string;
  const saved = new Map<symbol, unknown>();

  beforeEach(async () => {
    // Loaded first so what is saved is the default dispatcher, not undefined.
    void Headers;
    for (const key of DISPATCHER_KEYS) {
      saved.set(key, globals[key]);
    }
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.end('ok'));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the test server has no port');
    }
    url = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const installed = globals[KEY];
    for (const key of DISPATCHER_KEYS) {
      globals[key] = saved.get(key);
    }
    if (installed !== saved.get(KEY)) {
      await (installed as { close(): Promise<void> }).close();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a socket that refuses its type of service once connected fails no request and throws nothing', async () => {
    // The reported crash: a socket connected fine, the peer then reset it, and
    // the first request written on it set the type of service — macOS answers
    // EINVAL, and undici 7's `writeH1` let the throw escape the process. Here
    // the refusal is the handle's own answer, from the moment it connected.
    expect(installFetchDispatcher()).toBeNull();
    const refuse = ({ socket }: { socket: Socket }): void => {
      handleOf(socket).setTypeOfService = () => UV_EINVAL;
    };
    subscribe('undici:client:connected', refuse as (message: unknown) => void);
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(3_000),
      });
      expect(await res.text()).toBe('ok');
    } finally {
      unsubscribe(
        'undici:client:connected',
        refuse as (message: unknown) => void,
      );
    }
  });

  it('a socket that refuses its type of service at connect fails that request as an ordinary rejection', async () => {
    // Where the setting now happens: Node reports a refusal there as the
    // socket's `error` event, so the request rejects and the process lives on.
    expect(installFetchDispatcher()).toBeNull();
    const probe = connect(Number(new URL(url).port), '127.0.0.1');
    await new Promise<void>((resolve) => probe.once('connect', resolve));
    const tcp = Object.getPrototypeOf(handleOf(probe)) as TcpHandle;
    probe.destroy();
    vi.spyOn(tcp, 'setTypeOfService').mockReturnValue(UV_EINVAL);

    const outcome = await fetch(url, {
      method: 'POST',
      body: '{}',
      signal: AbortSignal.timeout(3_000),
    }).then(
      () => 'resolved',
      (error: unknown) => (error as { cause?: unknown }).cause,
    );
    expect(outcome).toMatchObject({
      code: 'EINVAL',
      syscall: 'setTypeOfService',
    });
  });
});

describe('installFetchDispatcher, on a scope of its own', () => {
  it('replaces undici’s default Agent with one that sets the type of service at connect', () => {
    const made: unknown[] = [];
    class Agent {
      constructor(options?: unknown) {
        made.push(options);
      }
    }
    const scope: Record<PropertyKey, unknown> = { [KEY]: new Agent() };
    made.length = 0;

    expect(installFetchDispatcher(scope)).toBeNull();

    expect(made).toEqual([{ connect: { typeOfService: 0 } }]);
    expect(scope[KEY]).toBeInstanceOf(Agent);
    expect(scope[KEY_V2]).toBe(scope[KEY]);
  });

  it('leaves any other dispatcher alone and says why', () => {
    class EnvHttpProxyAgent {}
    const chosen = new EnvHttpProxyAgent();
    const scope: Record<PropertyKey, unknown> = { [KEY]: chosen };

    expect(installFetchDispatcher(scope)).toContain('EnvHttpProxyAgent');
    expect(scope[KEY]).toBe(chosen);
  });

  it('does nothing when there is no dispatcher at all', () => {
    const scope: Record<PropertyKey, unknown> = {};

    expect(installFetchDispatcher(scope)).toBe(
      'no global fetch dispatcher to replace',
    );
    expect(scope[KEY]).toBeUndefined();
  });
});
