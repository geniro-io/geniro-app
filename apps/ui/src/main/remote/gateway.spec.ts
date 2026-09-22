import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IpcRegistry } from '../ipc-registry';
import { DeviceRegistry } from './device-registry';
import { type GatewayOptions, RemoteGateway } from './gateway';
import { Pairing } from './pairing';

const ALLOWED_HOST_NAME = 'my-gateway-test-host';

interface RawResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

/** A raw HTTP request whose Host header is set exactly as given, not derived from the connection target. */
function rawRequest(
  port: number,
  options: { path: string; method?: string; host?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.host !== undefined ? { host: options.host } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A raw upgrade request over a socket this test owns, so a refused upgrade (no response, socket closed) is directly observable. */
function rawUpgrade(
  port: number,
  host: string,
): Promise<{ gotResponse: boolean; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: ${host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'),
      );
    });
    let gotResponse = false;
    socket.on('data', () => {
      gotResponse = true;
    });
    socket.on('close', () => resolve({ gotResponse, closed: true }));
    socket.on('error', reject);
    // Guards the test itself against a genuine hang — if the guard were
    // reverted, the socket would sit open waiting for a proxied response
    // that never arrives from an absent daemon.
    setTimeout(() => {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }, 2_000);
  });
}

function listenOnAnyPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => res.end('occupied'));
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound port');
      }
      resolve({ server, port: address.port });
    });
  });
}

function makeGatewayOptions(
  staticRoot: string,
  overrides: Partial<GatewayOptions> = {},
): GatewayOptions {
  const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
  return {
    pairing: new Pairing(),
    deviceRegistry: new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    }),
    ipcRegistry: new IpcRegistry(),
    daemonHandle: () => null,
    staticRoot,
    preferredPort: 0,
    allowedHostNames: [ALLOWED_HOST_NAME],
    ...overrides,
  };
}

const gateways: RemoteGateway[] = [];
const plainServers: Server[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop()));
  await Promise.all(
    plainServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('RemoteGateway: host guard', () => {
  it('refuses a foreign Host on an ordinary request with 403', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: 'evil.example.com',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a foreign Host on the WebSocket upgrade path — no response, socket closed', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const result = await rawUpgrade(port, 'evil.example.com');

    // A refused upgrade never gets a 101 (or any other HTTP response) at
    // all — the guard destroys the raw socket before Node's own HTTP
    // upgrade machinery has anything to answer with.
    expect(result.gotResponse).toBe(false);
    expect(result.closed).toBe(true);
  });

  // `extraAllowedHosts` is how an OPEN tunnel widens the guard. It has to
  // reach BOTH arms: a phone on the public address that could list chats and
  // never watch one is the exact shape of a bug this directory has already
  // shipped once, on the upgrade path.
  it('admits a tunnel’s host pattern on an ordinary request', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => ['*.trycloudflare.com'],
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: 'keyword-portsmouth.trycloudflare.com',
    });

    expect(response.status).not.toBe(403);
  });

  it('admits a tunnel’s host pattern on the WebSocket upgrade path too', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => ['*.trycloudflare.com'],
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const result = await rawUpgrade(port, 'abc.trycloudflare.com');

    // It gets PAST the host guard — the pairing gate below it still refuses
    // this unpaired socket, which is why the assertion is about the guard
    // rather than about a 101.
    expect(result.closed).toBe(true);
  });

  it('stops admitting the pattern the moment the tunnel closes', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    let open = true;
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        extraAllowedHosts: () => (open ? ['*.trycloudflare.com'] : []),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }
    const host = 'abc.trycloudflare.com';
    expect((await rawRequest(port, { path: '/', host })).status).not.toBe(403);

    open = false;

    // Read FRESH per request, which is the whole reason the option is a
    // function: a mask captured at construction would admit the provider's
    // zone for the rest of the launch, with no tunnel behind it.
    expect((await rawRequest(port, { path: '/', host })).status).toBe(403);
  });

  it('accepts a request whose Host is in the allowed list (sanity: the guard is not refusing everything)', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).not.toBe(403);
  });
});

describe('RemoteGateway: static serving', () => {
  it('refuses a request that would resolve outside the static root, segment-wise', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    // A SIBLING directory whose name merely begins with the root's — the
    // exact case a bare `startsWith(root)` would wrongly admit.
    const siblingDir = `${staticRoot}-evil`;
    mkdirSync(siblingDir);
    writeFileSync(join(siblingDir, 'secret.txt'), 'top secret');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    // `%2F` survives the WHATWG URL parser unmolested (it is not treated as
    // a path separator during dot-segment normalization), so this is the
    // shape of request whose traversal only appears after this module's
    // OWN `decodeURIComponent` — which is exactly why the containment
    // check has to run AFTER decoding, not merely trust `url.pathname`.
    const response = await rawRequest(port, {
      path:
        '/..%2F' +
        encodeURIComponent(siblingDir.split('/').pop() ?? '') +
        '/secret.txt',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(403);
    expect(response.body).not.toContain('top secret');
  });

  it('serves a real file inside the root (sanity: the guard is not refusing legitimate paths)', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(
      join(staticRoot, 'index.html'),
      '<html>hello from root</html>',
    );

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(200);
    expect(response.body).toContain('hello from root');
  });

  it('never serves a .map file', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html>ok</html>');
    writeFileSync(join(staticRoot, 'app.js.map'), '{"version":3}');

    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port();
    if (port === null) {
      throw new Error('expected the gateway to be listening');
    }

    const response = await rawRequest(port, {
      path: '/app.js.map',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(response.status).toBe(404);
  });
});

describe('RemoteGateway: port fallback', () => {
  it('falls back to a free port when the preferred one is already in use', async () => {
    const { server: conflictServer, port: conflictPort } =
      await listenOnAnyPort();
    plainServers.push(conflictServer);

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, { preferredPort: conflictPort }),
    );
    gateways.push(gateway);

    await gateway.start();

    const boundPort = gateway.port();
    expect(boundPort).not.toBeNull();
    expect(boundPort).not.toBe(conflictPort);
  });
});

describe('RemoteGateway: the pairing gate on the proxied surfaces', () => {
  /** A raw request that also carries a Cookie header, which `rawRequest` does not. */
  function requestWithCookie(
    port: number,
    options: { path: string; host: string; cookie?: string },
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: options.host };
      if (options.cookie !== undefined) {
        headers.cookie = options.cookie;
      }
      const req = httpRequest(
        { host: '127.0.0.1', port, path: options.path, headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * The proxy injects the DAEMON's own bearer token, so an ungated arm hands
   * an unpaired stranger on the Wi-Fi the credential the daemon's guard
   * exists to demand — and `POST /v1/chats` starts an agent. This is the
   * finding the whole gate was added for: it guarded the bridge and the
   * event stream and left these two open.
   */
  it('refuses /v1 to a caller with no paired cookie, without reaching the daemon', async () => {
    let daemonSawRequest = false;
    const daemon = createServer((_req, res) => {
      daemonSawRequest = true;
      res.writeHead(200).end('{}');
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const refused = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
    });

    expect(refused.status).toBe(401);
    // The point is not only the status: nothing must have been forwarded.
    expect(daemonSawRequest).toBe(false);
    expect(refused.body).not.toContain('daemon-secret');
  });

  it('refuses /v1 to a cookie no device holds', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(makeGatewayOptions(staticRoot));
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const refused = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie: 'geniro_remote=not-a-real-session',
    });

    expect(refused.status).toBe(401);
  });

  it('lets a paired device through to the daemon', async () => {
    const daemon = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sawAuth: req.headers.authorization }));
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'a-real-session', label: 'phone' });

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const allowed = await requestWithCookie(port, {
      path: '/v1/chats',
      host: `${ALLOWED_HOST_NAME}:${port}`,
      cookie: 'geniro_remote=a-real-session',
    });

    expect(allowed.status).toBe(200);
    // And the credential the daemon sees is the GATEWAY's to supply.
    expect(allowed.body).toContain('Bearer daemon-secret');
  });

  it('refuses a /ws upgrade with no paired cookie', async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: 1,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;

    const result = await rawUpgrade(port, `${ALLOWED_HOST_NAME}:${port}`);

    expect(result.gotResponse).toBe(false);
    expect(result.closed).toBe(true);
  });
});

describe('RemoteGateway: the /ws upgrade path shape', () => {
  /** An upgrade with an arbitrary path and cookie, unlike `rawUpgrade`'s fixed `/ws`. */
  function upgradeTo(
    port: number,
    options: { path: string; host: string; cookie?: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(port, '127.0.0.1', () => {
        const lines = [
          `GET ${options.path} HTTP/1.1`,
          `Host: ${options.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
        ];
        if (options.cookie !== undefined) {
          lines.push(`Cookie: ${options.cookie}`);
        }
        socket.write([...lines, '', ''].join('\r\n'));
      });
      socket.on('error', reject);
      // The observable is whether the DAEMON was dialled, which settles
      // within a tick of the gateway's decision either way.
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 250);
    });
  }

  /**
   * engine.io asks for `/ws/?EIO=4&transport=websocket` and the daemon
   * answers only that form. Matching `'/ws'` EXACTLY dropped every real
   * handshake at the gateway while every unit test still passed: the phone
   * could list chats and start a run and never watch one. Driving a real
   * `ws` client is what found it; this is the observable that keeps it found
   * — whether the gateway dialled the daemon at all.
   */
  it('proxies the trailing-slash form engine.io actually requests', async () => {
    let daemonConnections = 0;
    const daemon = createServer();
    daemon.on('connection', () => {
      daemonConnections += 1;
    });
    plainServers.push(daemon);
    await new Promise<void>((resolve) =>
      daemon.listen(0, '127.0.0.1', resolve),
    );
    const daemonPort = (daemon.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), 'geniro-gateway-registry-'));
    const deviceRegistry = new DeviceRegistry({
      filePath: join(dir, 'remote-devices.json'),
    });
    deviceRegistry.add({ token: 'ws-session', label: 'phone' });

    const staticRoot = mkdtempSync(join(tmpdir(), 'geniro-gateway-static-'));
    writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
    const gateway = new RemoteGateway(
      makeGatewayOptions(staticRoot, {
        deviceRegistry,
        daemonHandle: () => ({
          host: '127.0.0.1',
          port: daemonPort,
          token: 'daemon-secret',
          version: '1.0.0',
          startedAt: new Date(0).toISOString(),
        }),
      }),
    );
    gateways.push(gateway);
    await gateway.start();
    const port = gateway.port()!;
    const host = `${ALLOWED_HOST_NAME}:${port}`;

    await upgradeTo(port, {
      path: '/ws/?EIO=4&transport=websocket',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(1);

    // The bare form still works — nothing about the fix narrows it.
    await upgradeTo(port, {
      path: '/ws',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(2);

    // And a path that merely STARTS with the letters is still refused, so
    // the fix widened the match without opening it.
    await upgradeTo(port, {
      path: '/wsnot',
      host,
      cookie: 'geniro_remote=ws-session',
    });
    expect(daemonConnections).toBe(2);
  });
});
