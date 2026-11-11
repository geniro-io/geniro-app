import { once } from 'node:events';
import {
  createServer as createHttpServer,
  get,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server as HttpServer,
} from 'node:http';
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Server as TcpServer,
  type Socket,
} from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type EgressProxy, startEgressProxy } from './egress-proxy';

const listen = async <T extends HttpServer | TcpServer>(
  server: T,
): Promise<number> => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
};

const closeServer = (server: HttpServer | TcpServer): Promise<void> =>
  new Promise((resolve) => {
    if ('closeAllConnections' in server) {
      server.closeAllConnections();
    }
    server.close(() => resolve());
  });

const closedPort = async (): Promise<number> => {
  const server = createTcpServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
};

/** Sends a CONNECT and resolves with the status line and what followed it. */
const sendConnect = (
  proxyPort: number,
  authority: string,
): Promise<{ socket: Socket; head: string; rest: string }> =>
  new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1');
    let received = '';
    socket.on('error', reject);
    socket.on('data', function onData(chunk: Buffer) {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      socket.off('data', onData);
      resolve({
        socket,
        head: received.slice(0, end),
        rest: received.slice(end + 4),
      });
    });
    socket.on('close', () => {
      if (!received.includes('\r\n\r\n')) {
        resolve({ socket, head: received, rest: '' });
      }
    });
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });

const echoThrough = (socket: Socket, text: string): Promise<string> =>
  new Promise((resolve) => {
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    socket.write(text);
  });

describe('egress proxy, over real sockets', () => {
  let proxy: EgressProxy;
  let echo: TcpServer;
  let echoPort: number;
  let origin: HttpServer;
  let originPort: number;
  let originHits: { url: string | undefined; headers: IncomingHttpHeaders }[];
  const sockets: Socket[] = [];

  beforeEach(async () => {
    proxy = await startEgressProxy();
    echo = createTcpServer((socket) => {
      socket.on('error', () => socket.destroy());
      socket.pipe(socket);
    });
    echoPort = await listen(echo);
    originHits = [];
    origin = createHttpServer((req: IncomingMessage, res) => {
      originHits.push({ url: req.url, headers: req.headers });
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.setHeader('Content-Type', 'text/plain');
      res.end(`origin saw ${req.url}`);
    });
    originPort = await listen(origin);
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    await proxy.close();
    await closeServer(echo);
    await closeServer(origin);
  });

  it('tunnels CONNECT to a loopback target', async () => {
    const tunnel = await sendConnect(proxy.port, `127.0.0.1:${echoPort}`);
    sockets.push(tunnel.socket);

    expect(tunnel.head).toMatch(/^HTTP\/1\.1 200 /);
    expect(await echoThrough(tunnel.socket, 'ping through the tunnel')).toBe(
      'ping through the tunnel',
    );
  });

  it('forwards an absolute-form GET', async () => {
    const answer = await new Promise<{
      status: number | undefined;
      body: string;
      setCookie: string[] | undefined;
    }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://127.0.0.1:${originPort}/hello?x=1`,
          headers: {
            Host: `127.0.0.1:${originPort}`,
            'Proxy-Connection': 'keep-alive',
            'X-Kept': 'yes',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body,
              setCookie: res.headers['set-cookie'],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(answer.status).toBe(200);
    expect(answer.body).toBe('origin saw /hello?x=1');
    expect(answer.setCookie).toEqual(['a=1', 'b=2']);
    expect(originHits).toHaveLength(1);
    expect(originHits[0]!.headers['x-kept']).toBe('yes');
    expect(originHits[0]!.headers['proxy-connection']).toBeUndefined();
  });

  it('forwards a request body to the origin', async () => {
    const received = new Promise<string>((resolve) => {
      origin.removeAllListeners('request');
      origin.on('request', (req, res) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => (body += chunk));
        req.on('end', () => {
          res.end();
          resolve(body);
        });
      });
    });
    const req = request({
      host: '127.0.0.1',
      port: proxy.port,
      method: 'POST',
      path: `http://127.0.0.1:${originPort}/submit`,
      headers: { Host: `127.0.0.1:${originPort}` },
    });
    req.on('error', () => undefined);
    req.end('field=value');

    expect(await received).toBe('field=value');
  });

  it('refuses an origin-form request with 400 and never reaches the target', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: '/hello',
          headers: { Host: `127.0.0.1:${originPort}` },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      ).on('error', reject);
    });

    expect(status).toBe(400);
    expect(originHits).toEqual([]);
  });

  it('maps *.localhost to 127.0.0.1', async () => {
    for (const name of ['app.localhost', 'a.b.localhost', 'localhost']) {
      const tunnel = await sendConnect(proxy.port, `${name}:${echoPort}`);
      sockets.push(tunnel.socket);

      expect(tunnel.head, name).toMatch(/^HTTP\/1\.1 200 /);
      expect(await echoThrough(tunnel.socket, name), name).toBe(name);
    }
  });

  it('reaches a localhost stand that listens on ::1 only', async () => {
    const v6 = createTcpServer((socket) => {
      socket.on('error', () => socket.destroy());
      socket.pipe(socket);
    });
    v6.listen(0, '::1');
    await once(v6, 'listening');
    const v6Port = (v6.address() as AddressInfo).port;
    const tunnel = await sendConnect(proxy.port, `localhost:${v6Port}`);
    try {
      expect(tunnel.head).toMatch(/^HTTP\/1\.1 200 /);
      expect(await echoThrough(tunnel.socket, 'v6')).toBe('v6');
    } finally {
      tunnel.socket.destroy();
      await proxy.close();
      await closeServer(v6);
      proxy = await startEgressProxy();
    }
  });

  it('tunnels CONNECT to port 80, which a URL drops as the default', async () => {
    const tunnel = await sendConnect(proxy.port, 'localhost:80');
    sockets.push(tunnel.socket);

    expect(tunnel.head).not.toMatch(/^HTTP\/1\.1 400 /);
  });

  it('maps *.localhost to 127.0.0.1 for a forwarded http request too', async () => {
    const body = await new Promise<string>((resolve, reject) => {
      get(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://dev.localhost:${originPort}/page`,
          headers: { Host: `dev.localhost:${originPort}` },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => resolve(text));
        },
      ).on('error', reject);
    });

    expect(body).toBe('origin saw /page');
    expect(originHits[0]!.headers.host).toBe(`dev.localhost:${originPort}`);
  });

  it('answers 502 when the CONNECT target refuses', async () => {
    const port = await closedPort();

    const refused = await sendConnect(proxy.port, `127.0.0.1:${port}`);
    sockets.push(refused.socket);

    expect(refused.head).toMatch(/^HTTP\/1\.1 502 /);
    if (!refused.socket.closed) {
      await once(refused.socket, 'close');
    }
    expect(refused.socket.closed).toBe(true);
  });

  it('answers 502 to a forwarded request whose target refuses', async () => {
    const port = await closedPort();

    const status = await new Promise<number | undefined>((resolve, reject) => {
      get(
        {
          host: '127.0.0.1',
          port: proxy.port,
          path: `http://127.0.0.1:${port}/`,
          headers: { Host: `127.0.0.1:${port}` },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      ).on('error', reject);
    });

    expect(status).toBe(502);
  });

  it('answers 400 to a CONNECT with no port', async () => {
    const bad = await sendConnect(proxy.port, 'example.com');
    sockets.push(bad.socket);

    expect(bad.head).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('close() destroys open tunnels', async () => {
    const tunnel = await sendConnect(proxy.port, `127.0.0.1:${echoPort}`);
    sockets.push(tunnel.socket);
    expect(await echoThrough(tunnel.socket, 'up')).toBe('up');

    const closed = once(tunnel.socket, 'close');
    await proxy.close();
    await closed;

    expect(tunnel.socket.destroyed).toBe(true);
  });
});
