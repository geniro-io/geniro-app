import type { IncomingMessage, Server } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { connect as netConnect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import { proxyHttp, proxyUpgrade } from './daemon-proxy';

function makeHandle(port: number, token: string): DaemonHandle {
  return {
    host: '127.0.0.1',
    port,
    token,
    version: '0.0.0',
    startedAt: new Date().toISOString(),
  };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a bound port');
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // Node's `server.close()` only stops accepting new connections and
    // waits for every existing one to end on its own — a raw socket this
    // suite drove directly (rather than through a client that closes
    // itself promptly) can otherwise leave the callback waiting well past
    // the suite's own hook timeout.
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

describe('proxyHttp', () => {
  it("attaches the daemon's own bearer token and strips the client's authorization/cookie headers", async () => {
    let received: IncomingMessage | null = null;
    const daemon = createServer((req, res) => {
      received = req;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(daemon);
    const daemonPort = await listen(daemon);
    const handle = makeHandle(daemonPort, 'real-daemon-token');

    const gateway = createServer((req, res) => proxyHttp(req, res, handle));
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/whoami`, {
      headers: {
        authorization: 'Bearer client-forged-token',
        cookie: 'geniro_remote=phone-session',
      },
    });
    const body = (await response.json()) as { ok: boolean };

    expect(body).toEqual({ ok: true });
    expect(received).not.toBeNull();
    // The real daemon token was attached by the proxy itself...
    expect(received!.headers.authorization).toBe('Bearer real-daemon-token');
    // ...and the client's own authorization/cookie never arrived at all.
    expect(received!.headers.cookie).toBeUndefined();
    expect(received!.headers.authorization).not.toContain(
      'client-forged-token',
    );
  });

  it("never puts the daemon's token anywhere in the response sent back to the client", async () => {
    const daemon = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(daemon);
    const daemonPort = await listen(daemon);
    const handle = makeHandle(daemonPort, 'super-secret-token');

    const gateway = createServer((req, res) => proxyHttp(req, res, handle));
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/whoami`);
    const text = await response.text();
    const headerDump = JSON.stringify([...response.headers.entries()]);

    expect(text).not.toContain('super-secret-token');
    expect(headerDump).not.toContain('super-secret-token');
  });

  it('ends the client request rather than hanging when the daemon is unreachable', async () => {
    // A closed port — nothing is listening — so the upstream connection is
    // refused immediately. This is the fast, deterministic way to drive the
    // proxy's error path; the module's own 30s response timeout guards a
    // daemon that accepted the connection and then went silent, which is
    // the same "must not hang the client open" contract but not one a unit
    // test should sit through in real time.
    const daemon = createServer((_req, res) => res.end());
    const daemonPort = await listen(daemon);
    await close(daemon);
    const handle = makeHandle(daemonPort, 'token');

    const gateway = createServer((req, res) => proxyHttp(req, res, handle));
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const response = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/unreachable`,
      {
        signal: AbortSignal.timeout(5_000),
      },
    );
    expect(response.status).toBe(502);
  });
});

describe('proxyUpgrade', () => {
  it('rewrites the token query param to the real daemon token and pipes both directions', async () => {
    let daemonRequestUrl: string | undefined;
    let daemonRequestHeaders: IncomingMessage['headers'] | undefined;
    const daemon = createServer();
    daemon.on('upgrade', (req, socket, head) => {
      daemonRequestUrl = req.url;
      daemonRequestHeaders = req.headers;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      if (head.length > 0) {
        socket.write(head);
      }
      // Echo whatever the client sends back, so the test can observe both
      // directions of the pipe rather than just the daemon's receipt.
      socket.on('data', (chunk: Buffer) => socket.write(chunk));
      // A well-behaved peer closes its own side once the other half is
      // done, same as `proxyUpgrade` itself does — without this the fake
      // daemon's socket sits half-open after the gateway tears its side
      // down, which is exactly the leak this suite exists to catch.
      socket.on('end', () => socket.destroy());
    });
    servers.push(daemon);
    const daemonPort = await listen(daemon);
    const handle = makeHandle(daemonPort, 'real-ws-token');

    const gateway = createServer();
    gateway.on('upgrade', (req, socket: Socket, head) =>
      proxyUpgrade(req, socket, head, handle),
    );
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    const echoed = await new Promise<string>((resolve, reject) => {
      const client = netConnect(gatewayPort, '127.0.0.1', () => {
        client.write(
          [
            'GET /ws?token=phone-guessed-token HTTP/1.1',
            'Host: 127.0.0.1',
            'Connection: Upgrade',
            'Upgrade: websocket',
            // The two headers `forwardableHeaders` strips on the ordinary
            // HTTP path (`proxyHttp`) — carried here too, since an upgrade
            // is a raw socket write and nothing stops a phone's browser (or
            // a hand-rolled client) from sending them on this path as well.
            'Authorization: Bearer client-forged-token',
            'Cookie: geniro_remote=phone-session',
            '',
            '',
          ].join('\r\n'),
        );
      });
      let buffer = '';
      let switched = false;
      client.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (!switched && buffer.includes('\r\n\r\n')) {
          switched = true;
          client.write('ping-payload');
          buffer = '';
          return;
        }
        if (switched && buffer.length > 0) {
          resolve(buffer);
          client.destroy();
        }
      });
      client.on('error', reject);
    });

    expect(echoed).toBe('ping-payload');
    expect(daemonRequestUrl).toContain('token=real-ws-token');
    expect(daemonRequestUrl).not.toContain('phone-guessed-token');
    // The daemon must see NEITHER — the gateway's own pairing cookie is a
    // fact about pairing with the GATEWAY, and a client's own Authorization
    // must never reach the daemon it did not authenticate to.
    expect(daemonRequestHeaders?.authorization).toBeUndefined();
    expect(daemonRequestHeaders?.cookie).toBeUndefined();
  });

  it('destroys both sockets when the client side closes', async () => {
    const daemon = createServer();
    let daemonSocketClosed = false;
    daemon.on('upgrade', (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      socket.on('close', () => {
        daemonSocketClosed = true;
      });
      // See the previous test's identical comment: closing only the
      // gateway's own side leaves this end half-open under nothing but a
      // graceful `end`.
      socket.on('end', () => socket.destroy());
    });
    servers.push(daemon);
    const daemonPort = await listen(daemon);
    const handle = makeHandle(daemonPort, 'token');

    const gateway = createServer();
    gateway.on('upgrade', (req, socket: Socket, head) =>
      proxyUpgrade(req, socket, head, handle),
    );
    servers.push(gateway);
    const gatewayPort = await listen(gateway);

    await new Promise<void>((resolve, reject) => {
      const client = netConnect(gatewayPort, '127.0.0.1', () => {
        client.write(
          [
            'GET /ws HTTP/1.1',
            'Host: 127.0.0.1',
            'Connection: Upgrade',
            'Upgrade: websocket',
            '',
            '',
          ].join('\r\n'),
        );
      });
      client.on('data', () => {
        // Got the 101 response — now abruptly end the client side.
        client.destroy();
        // Give the teardown handlers a macrotask to run.
        setTimeout(resolve, 200);
      });
      client.on('error', reject);
    });

    expect(daemonSocketClosed).toBe(true);
  });
});
