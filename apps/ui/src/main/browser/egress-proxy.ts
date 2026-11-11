import { lookup as dnsLookup } from 'node:dns';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  request,
  type ServerResponse,
} from 'node:http';
import {
  connect,
  type LookupFunction,
  type Server,
  type Socket,
} from 'node:net';
import type { Duplex } from 'node:stream';

export interface EgressProxy {
  port: number;
  close(): Promise<void>;
}

const LOOPBACK_ADDRESS = '127.0.0.1';
const LOOPBACK_ADDRESS_V6 = '::1';

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n';
const BAD_REQUEST = 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n';
const TUNNEL_ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n';

const isLocalhostName = (hostname: string): boolean => {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
};

const resolveName: LookupFunction = (hostname, options, callback) => {
  if (isLocalhostName(hostname)) {
    if (options.all) {
      callback(null, [
        { address: LOOPBACK_ADDRESS, family: 4 },
        { address: LOOPBACK_ADDRESS_V6, family: 6 },
      ]);
    } else {
      callback(null, LOOPBACK_ADDRESS, 4);
    }
    return;
  }
  dnsLookup(hostname, options, callback);
};

const bareHost = (hostname: string): string =>
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;

function parseConnectTarget(
  authority: string | undefined,
): { host: string; port: number } | null {
  if (authority === undefined) {
    return null;
  }
  try {
    const url = new URL(`http://${authority}`);
    const port = Number(/:(\d{1,5})$/.exec(authority)?.[1] ?? Number.NaN);
    if (url.hostname === '' || !Number.isInteger(port) || port <= 0) {
      return null;
    }
    return { host: bareHost(url.hostname), port };
  } catch {
    return null;
  }
}

function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const named = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token !== ''),
  );
  const kept: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name) && !named.has(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

function refuseSocket(socket: Duplex, response: string): void {
  if (socket.writable) {
    socket.end(response);
  } else {
    socket.destroy();
  }
}

/**
 * The only way a browser tab's traffic leaves the process: a loopback HTTP
 * proxy that tunnels CONNECT and forwards absolute-form `http://` requests.
 * Origin-form requests are refused so a page cannot use the proxy as a relay
 * to loopback services by naming a path.
 */
export function startEgressProxy(): Promise<EgressProxy> {
  const open = new Set<Socket>();
  const track = (socket: Socket): Socket => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  };

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      forward(req, res, track);
    },
  );
  server.on('connection', track);
  server.on('connect', (req: IncomingMessage, client: Duplex, head: Buffer) => {
    tunnel(req, client, head, track);
  });
  server.on('clientError', (_error: Error, socket: Duplex) => {
    refuseSocket(socket, BAD_REQUEST);
  });

  return new Promise<EgressProxy>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_ADDRESS, () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the egress proxy has no port'));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of open) {
              socket.destroy();
            }
          }),
      });
    });
  });
}

function tunnel(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  track: (socket: Socket) => Socket,
): void {
  client.on('error', () => client.destroy());
  const target = parseConnectTarget(req.url);
  if (target === null) {
    refuseSocket(client, BAD_REQUEST);
    return;
  }
  const upstream = track(
    connect({ host: target.host, port: target.port, lookup: resolveName }),
  );
  let established = false;
  upstream.once('connect', () => {
    established = true;
    client.write(TUNNEL_ESTABLISHED);
    if (head.length > 0) {
      upstream.write(head);
    }
    client.pipe(upstream);
    upstream.pipe(client);
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });
  upstream.once('error', () => {
    if (!established) {
      refuseSocket(client, BAD_GATEWAY);
    }
  });
  client.on('close', () => upstream.destroy());
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  track: (socket: Socket) => Socket,
): void {
  let target: URL;
  try {
    target = new URL(req.url ?? '');
  } catch {
    refuse(res, 400);
    return;
  }
  if (target.protocol !== 'http:') {
    refuse(res, 400);
    return;
  }
  const upstream = request({
    host: bareHost(target.hostname),
    port: target.port === '' ? 80 : Number(target.port),
    path: `${target.pathname}${target.search}`,
    method: req.method,
    headers: forwardedHeaders(req.headers),
    lookup: resolveName,
    agent: false,
  });
  upstream.on('socket', track);
  upstream.once('response', (answer) => {
    res.writeHead(
      answer.statusCode ?? 502,
      answer.statusMessage,
      forwardedHeaders(answer.headers),
    );
    answer.on('error', () => res.destroy());
    answer.pipe(res);
  });
  upstream.once('error', () => {
    if (res.headersSent) {
      res.destroy();
    } else {
      refuse(res, 502);
    }
  });
  req.on('error', () => upstream.destroy());
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function refuse(res: ServerResponse, status: 400 | 502): void {
  res.writeHead(status, { Connection: 'close' });
  res.end();
}
