import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REMOTE_CSRF_HEADER, REMOTE_SESSION_COOKIE } from '../../shared/remote';
import {
  ALLOW_REMOTELY,
  allowRemotelyExceptFields,
  denyRemotely,
  IpcRegistry,
} from '../ipc-registry';
import { DeviceRegistry } from './device-registry';
import { Pairing } from './pairing';
import {
  createRemoteRoutes,
  type RemoteRoutesDeps,
  type RouteRequest,
  type SseResponse,
} from './remote-routes';

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    headers: {},
    cookies: {},
    remoteAddress: '192.168.1.50',
    userAgent: 'iPhone Safari',
    body: undefined,
    ...overrides,
  };
}

function makeDeps(): RemoteRoutesDeps & { registryDir: string } {
  const registryDir = mkdtempSync(join(tmpdir(), 'geniro-remote-routes-'));
  const pairing = new Pairing();
  const deviceRegistry = new DeviceRegistry({
    filePath: join(registryDir, 'remote-devices.json'),
  });
  const ipcRegistry = new IpcRegistry();
  return { pairing, deviceRegistry, ipcRegistry, registryDir };
}

/** Pairs a device and returns the raw token a client would carry as its cookie. */
function pairADevice(deps: RemoteRoutesDeps): string {
  const routes = createRemoteRoutes(deps);
  const code = deps.pairing.currentCode();
  const result = routes.pair(makeReq({ body: { code } }));
  expect(result.status).toBe(200);
  const match = /geniro_remote=([^;]+)/.exec(result.setCookie ?? '');
  const token = match?.[1];
  if (token === undefined) {
    throw new Error('pair() did not return a session cookie');
  }
  return token;
}

describe('createRemoteRoutes: session', () => {
  let deps: RemoteRoutesDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('answers unpaired with no cookie', () => {
    const routes = createRemoteRoutes(deps);
    const result = routes.session(makeReq());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ paired: false, deviceId: null });
  });

  it('answers paired for a cookie naming a real device, and touches it', () => {
    const token = pairADevice(deps);
    const [before] = deps.deviceRegistry.list();
    if (!before) {
      throw new Error('expected pairADevice to have registered a device');
    }

    const routes = createRemoteRoutes(deps);
    const result = routes.session(
      makeReq({ cookies: { [REMOTE_SESSION_COOKIE]: token } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { paired: boolean; deviceId: string | null };
    expect(body.paired).toBe(true);
    expect(body.deviceId).toBe(before.id);
  });

  it('answers unpaired for a cookie naming no device (revoked, forged, or stale)', () => {
    const routes = createRemoteRoutes(deps);
    const result = routes.session(
      makeReq({ cookies: { [REMOTE_SESSION_COOKIE]: 'not-a-real-token' } }),
    );
    expect(result.body).toEqual({ paired: false, deviceId: null });
  });
});

describe('createRemoteRoutes: pair', () => {
  let deps: RemoteRoutesDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('accepts the live code, adds a device, and sets a non-Secure session cookie', () => {
    const routes = createRemoteRoutes(deps);
    const code = deps.pairing.currentCode();

    const result = routes.pair(makeReq({ body: { code } }));

    expect(result.status).toBe(200);
    expect(result.setCookie).toBeDefined();
    expect(result.setCookie).toContain('HttpOnly');
    expect(result.setCookie).toContain('SameSite=Strict');
    // Deliberately NOT Secure — see the comment at `buildSessionCookie`.
    expect(result.setCookie).not.toContain('Secure');
    const devices = deps.deviceRegistry.list();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.label).toBe('iPhone Safari');
  });

  it('refuses a wrong code with 401 and never with a value-carrying request', () => {
    const routes = createRemoteRoutes(deps);
    const result = routes.pair(
      makeReq({ body: { code: '000000' }, remoteAddress: '10.0.0.9' }),
    );
    expect(result.status).toBe(401);
    expect(result.setCookie).toBeUndefined();
    expect(deps.deviceRegistry.list()).toHaveLength(0);
  });

  it('locks out and answers 429 after enough wrong attempts from one address', () => {
    const routes = createRemoteRoutes(deps);
    let last;
    for (let i = 0; i < 5; i += 1) {
      last = routes.pair(
        makeReq({ body: { code: '000000' }, remoteAddress: '10.0.0.9' }),
      );
    }
    expect(last?.status).toBe(429);
  });

  it('rejects a malformed body with 400', () => {
    const routes = createRemoteRoutes(deps);
    const result = routes.pair(makeReq({ body: { nope: true } }));
    expect(result.status).toBe(400);
  });
});

describe('createRemoteRoutes: bridge', () => {
  let deps: RemoteRoutesDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('refuses with 401 when the request carries no paired cookie', async () => {
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register('test:channel', ALLOW_REMOTELY, () => 'value');

    const result = await routes.bridge(
      makeReq({
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'test:channel', args: [] },
      }),
    );

    expect(result.status).toBe(401);
  });

  it('refuses with 403 when the cookie is paired but the CSRF header is missing', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register('test:channel', ALLOW_REMOTELY, () => 'value');

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        body: { channel: 'test:channel', args: [] },
      }),
    );

    expect(result.status).toBe(403);
  });

  it('answers 404 for a channel nothing registered', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'does:not-exist', args: [] },
      }),
    );

    expect(result.status).toBe(404);
  });

  it('answers a refusal — never runs the handler — for a channel with a deny policy', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    const handler = vi.fn(() => 'should never run');
    deps.ipcRegistry.register(
      'danger:channel',
      denyRemotely('needs a real window'),
      handler,
    );

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'danger:channel', args: [] },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      refusal: {
        code: 'REMOTE_CHANNEL_DENIED',
        channel: 'danger:channel',
        reason: 'needs a real window',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a remote call naming a field its policy excludes, before the handler runs', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    const handler = vi.fn(() => 'should never run');
    deps.ipcRegistry.register(
      'settings:update',
      allowRemotelyExceptFields(
        ['cliPaths'],
        'sets a field the desktop alone may set',
      ),
      handler,
    );

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: {
          channel: 'settings:update',
          args: [{ cliPaths: { claude: '/evil' } }],
        },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      refusal: {
        code: 'REMOTE_CHANNEL_DENIED',
        channel: 'settings:update',
        reason: 'sets a field the desktop alone may set (refused: cliPaths)',
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a remote call through an except-fields policy when it names none of the excluded fields', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register(
      'settings:update',
      allowRemotelyExceptFields(
        ['cliPaths'],
        'sets a field the desktop alone may set',
      ),
      (_event, patch) => ({ applied: patch }),
    );

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'settings:update', args: [{ theme: 'dark' }] },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ value: { applied: { theme: 'dark' } } });
  });

  it('invokes an allowed channel with its args and returns its value', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register(
      'math:add',
      ALLOW_REMOTELY,
      (_event, a, b) => (a as number) + (b as number),
    );

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'math:add', args: [2, 3] },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ value: 5 });
  });

  it('makes it impossible for an allowed handler to read a sender off its event', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register(
      'reads:sender',
      ALLOW_REMOTELY,
      (event: IpcMainInvokeEvent) => event.sender,
    );

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'reads:sender', args: [] },
      }),
    );

    // The handler THREW trying to read `.sender` — it never got an answer
    // back, which is the whole point of the stand-in: there is no
    // WebContents this bridge call could honestly hand it.
    expect(result.status).toBe(200);
    const body = result.body as { error?: string };
    expect(body.error).toBeDefined();
    expect(body.error).toContain('sender');
  });

  it('carries a thrown error back as {error}, never as a value', async () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    deps.ipcRegistry.register('always:throws', ALLOW_REMOTELY, () => {
      throw new Error('boom');
    });

    const result = await routes.bridge(
      makeReq({
        cookies: { [REMOTE_SESSION_COOKIE]: token },
        headers: { [REMOTE_CSRF_HEADER]: '1' },
        body: { channel: 'always:throws', args: [] },
      }),
    );

    expect(result.body).toEqual({ error: 'boom' });
  });
});

function fakeSseResponse(): SseResponse & {
  writes: string[];
  status: number | null;
  headers: Record<string, string> | null;
  ended: boolean;
  closeListeners: (() => void)[];
} {
  // A single self-referencing object, not a spread of a separate `state` —
  // spreading a plain object copies its PRIMITIVE fields by value, so a
  // later `res.status = …` inside `writeHead` would update a variable the
  // test never sees again.
  const res = {
    writes: [] as string[],
    status: null as number | null,
    headers: null as Record<string, string> | null,
    ended: false,
    closeListeners: [] as (() => void)[],
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.headers = headers;
    },
    write(chunk: string) {
      res.writes.push(chunk);
    },
    end(chunk?: string) {
      res.ended = true;
      if (chunk) {
        res.writes.push(chunk);
      }
    },
    on(_event: 'close', listener: () => void) {
      res.closeListeners.push(listener);
    },
  };
  return res;
}

describe('createRemoteRoutes: events', () => {
  let deps: RemoteRoutesDeps;

  beforeEach(() => {
    deps = makeDeps();
    vi.useFakeTimers();
  });

  it('refuses with 401 when unpaired, and opens no stream', () => {
    const routes = createRemoteRoutes(deps);
    const res = fakeSseResponse();

    routes.events(makeReq(), res);

    expect(res.status).toBe(401);
    expect(res.ended).toBe(true);
    const writesAfterRefusal = res.writes.length;
    vi.advanceTimersByTime(60_000);
    // No keep-alive interval was ever armed for a refused stream — nothing
    // more is written after the refusal body itself.
    expect(res.writes).toHaveLength(writesAfterRefusal);

    vi.useRealTimers();
  });

  it('opens an event-stream for a paired device and writes keep-alive comments', () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    const res = fakeSseResponse();

    routes.events(
      makeReq({ cookies: { [REMOTE_SESSION_COOKIE]: token } }),
      res,
    );

    expect(res.status).toBe(200);
    expect(res.headers?.['content-type']).toBe('text/event-stream');
    expect(res.writes).toHaveLength(0);

    vi.advanceTimersByTime(15_000);
    expect(res.writes).toEqual([': keep-alive\n\n']);

    vi.advanceTimersByTime(15_000);
    expect(res.writes).toHaveLength(2);

    vi.useRealTimers();
  });

  it('stops writing keep-alives once the connection closes', () => {
    const token = pairADevice(deps);
    const routes = createRemoteRoutes(deps);
    const res = fakeSseResponse();

    routes.events(
      makeReq({ cookies: { [REMOTE_SESSION_COOKIE]: token } }),
      res,
    );
    vi.advanceTimersByTime(15_000);
    expect(res.writes).toHaveLength(1);

    for (const listener of res.closeListeners) {
      listener();
    }
    vi.advanceTimersByTime(60_000);
    // The interval was cleared on close — nothing further was written.
    expect(res.writes).toHaveLength(1);

    vi.useRealTimers();
  });
});
