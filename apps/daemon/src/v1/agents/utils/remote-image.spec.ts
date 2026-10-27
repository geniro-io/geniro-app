import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  downloadRemoteImage,
  isPublicAddress,
  isRemoteImageUrl,
  RemoteImageError,
  type ResolveAll,
} from './remote-image';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

type Route = (request: IncomingMessage, response: ServerResponse) => void;

const routes = new Map<string, Route>();
let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((request, response) => {
    const route = routes.get(request.url ?? '');
    if (route === undefined) {
      response.writeHead(404).end();
      return;
    }
    route(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Every name resolves to the given address. */
function resolvingTo(address: string, family = 4): ResolveAll {
  return (_hostname, callback) => callback(null, [{ address, family }]);
}

/** Loopback is allowed, so the local server stands in for a public host. */
const local = {
  resolve: resolvingTo('127.0.0.1'),
  isAllowedAddress: (address: string) => address === '127.0.0.1',
};

function at(path: string): string {
  return `http://images.test:${port}${path}`;
}

async function refusal(promise: Promise<unknown>): Promise<RemoteImageError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(RemoteImageError);
  return error as RemoteImageError;
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.5',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    'fd00::1',
    'fe80::1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a00:1',
    '2002:c0a8:101::1',
    '2001:0:4136:e378::1',
    'not-an-address',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '151.101.1.69', '2606:4700::1111'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('isRemoteImageUrl', () => {
  it('tells a web address from a path', () => {
    expect(isRemoteImageUrl('https://example.com/a.png')).toBe(true);
    expect(isRemoteImageUrl('  HTTP://example.com/a.png')).toBe(true);
    expect(isRemoteImageUrl('/tmp/a.png')).toBe(false);
    expect(isRemoteImageUrl('file:///tmp/a.png')).toBe(false);
  });
});

describe('downloadRemoteImage', () => {
  it('downloads a picture and types it by its bytes', async () => {
    routes.set('/a.png', (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' }).end(PNG);
    });
    const image = await downloadRemoteImage(at('/a.png'), local);
    expect(image.mediaType).toBe('image/png');
    expect(image.bytes.equals(PNG)).toBe(true);
  });

  it('follows a redirect to a picture', async () => {
    routes.set('/moved', (_request, response) => {
      response.writeHead(302, { location: '/a.png' }).end();
    });
    routes.set('/a.png', (_request, response) => {
      response.writeHead(200).end(PNG);
    });
    const image = await downloadRemoteImage(at('/moved'), local);
    expect(image.mediaType).toBe('image/png');
  });

  it('refuses a host that resolves to this machine', async () => {
    routes.set('/a.png', (_request, response) => {
      response.writeHead(200).end(PNG);
    });
    const error = await refusal(
      downloadRemoteImage(at('/a.png'), { resolve: resolvingTo('127.0.0.1') }),
    );
    expect(error.message).toBe('images.test is not a public internet host');
  });

  it('refuses a host that resolves to the local network', async () => {
    const error = await refusal(
      downloadRemoteImage('http://printer.test/a.png', {
        resolve: resolvingTo('192.168.1.20'),
      }),
    );
    expect(error.message).toBe('printer.test is not a public internet host');
  });

  it('refuses an IP literal on this machine without resolving it', async () => {
    const error = await refusal(
      downloadRemoteImage(`http://127.0.0.1:${port}/a.png`, {
        resolve: () => {
          throw new Error('an IP literal is never looked up');
        },
      }),
    );
    expect(error.message).toBe('127.0.0.1 is not a public internet address');
  });

  it('refuses a redirect into the local network', async () => {
    routes.set('/to-private', (_request, response) => {
      response
        .writeHead(301, { location: 'http://169.254.169.254/latest' })
        .end();
    });
    const error = await refusal(downloadRemoteImage(at('/to-private'), local));
    expect(error.message).toBe(
      '169.254.169.254 is not a public internet address',
    );
  });

  it('follows three redirects and refuses a fourth', async () => {
    for (const [from, to] of [
      ['/r1', '/r2'],
      ['/r2', '/r3'],
      ['/r3', '/a.png'],
      ['/r0', '/r1'],
    ]) {
      routes.set(from!, (_request, response) => {
        response.writeHead(302, { location: to }).end();
      });
    }
    routes.set('/a.png', (_request, response) => {
      response.writeHead(200).end(PNG);
    });

    const image = await downloadRemoteImage(at('/r1'), local);
    expect(image.mediaType).toBe('image/png');
    const error = await refusal(downloadRemoteImage(at('/r0'), local));
    expect(error.message).toBe('too many redirects');
  });

  it('refuses a host when ANY of its addresses is not public', async () => {
    routes.set('/a.png', (_request, response) => {
      response.writeHead(200).end(PNG);
    });
    const error = await refusal(
      downloadRemoteImage(at('/a.png'), {
        isAllowedAddress: (address) => address === '127.0.0.1',
        resolve: (_hostname, callback) =>
          callback(null, [
            { address: '127.0.0.1', family: 4 },
            { address: '10.0.0.7', family: 4 },
          ]),
      }),
    );
    expect(error.message).toBe('images.test is not a public internet host');
  });

  it('refuses a host that resolves to no address at all', async () => {
    const error = await refusal(
      downloadRemoteImage(at('/a.png'), {
        isAllowedAddress: () => true,
        resolve: (_hostname, callback) => callback(null, []),
      }),
    );
    expect(error.message).toBe('images.test is not a public internet host');
  });

  it.each([
    ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
    ['gif', Buffer.from('GIF89a\u0000\u0000', 'latin1'), 'image/gif'],
    [
      'webp',
      Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'),
      'image/webp',
    ],
  ])('types a %s by its bytes', async (name, bytes, mediaType) => {
    routes.set(`/x.${name}`, (_request, response) => {
      response.writeHead(200).end(bytes);
    });
    const image = await downloadRemoteImage(at(`/x.${name}`), local);
    expect(image.mediaType).toBe(mediaType);
  });

  it('refuses an avif, which the image route cannot serve', async () => {
    routes.set('/x.avif', (_request, response) => {
      response
        .writeHead(200)
        .end(Buffer.from('\u0000\u0000\u0000\u0018ftypavif', 'latin1'));
    });
    const error = await refusal(downloadRemoteImage(at('/x.avif'), local));
    expect(error.message).toBe('not a png, jpeg, gif or webp image');
  });

  it('names only the error code of a connection that failed', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, '127.0.0.1', resolve),
    );
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await refusal(
      downloadRemoteImage(`http://images.test:${closedPort}/a.png`, local),
    );
    expect(error.message).toBe('the download failed (ECONNREFUSED)');
  });

  it('stops when the caller stops it, with the caller’s reason', async () => {
    routes.set('/slow', () => undefined);
    const stop = new AbortController();
    const download = downloadRemoteImage(at('/slow'), {
      ...local,
      signal: stop.signal,
      abortReason: 'out of time',
    });
    stop.abort();
    const error = await refusal(download);
    expect(error.message).toBe('out of time');
  });

  it('refuses a scheme other than http and https', async () => {
    const error = await refusal(downloadRemoteImage('ftp://example.com/a.png'));
    expect(error.message).toBe('only http and https URLs are downloaded');
  });

  it('refuses a URL carrying credentials', async () => {
    const error = await refusal(
      downloadRemoteImage('https://user:secret@example.com/a.png'),
    );
    expect(error.message).toBe('a URL carrying credentials is not downloaded');
  });

  it('reports a status other than 200', async () => {
    const error = await refusal(downloadRemoteImage(at('/missing'), local));
    expect(error.message).toBe('the server answered HTTP 404');
  });

  it('refuses bytes that are not a picture', async () => {
    routes.set('/page', (_request, response) => {
      response
        .writeHead(200, { 'content-type': 'image/png' })
        .end('<html></html>');
    });
    const error = await refusal(downloadRemoteImage(at('/page'), local));
    expect(error.message).toBe('not a png, jpeg, gif or webp image');
  });

  it('refuses a declared size over the ceiling before reading it', async () => {
    // Eight bytes sent and the body never ended: only the declared length can
    // say "larger" here — without that check this would time out instead.
    routes.set('/big', (_request, response) => {
      response.writeHead(200, { 'content-length': '1000' });
      response.write(PNG.subarray(0, 8));
    });
    const error = await refusal(
      downloadRemoteImage(at('/big'), {
        ...local,
        maxBytes: 16,
        timeoutMs: 2000,
      }),
    );
    expect(error.message).toMatch(/^larger than the /);
  });

  it('refuses an undeclared size once the stream passes the ceiling', async () => {
    routes.set('/chunked', (_request, response) => {
      response.writeHead(200);
      response.write(PNG);
      response.end(PNG);
    });
    const error = await refusal(
      downloadRemoteImage(at('/chunked'), {
        ...local,
        maxBytes: PNG.length + 1,
      }),
    );
    expect(error.message).toMatch(/^larger than the /);
  });

  it('gives up on a server that never answers', async () => {
    routes.set('/hang', () => undefined);
    const error = await refusal(
      downloadRemoteImage(at('/hang'), { ...local, timeoutMs: 100 }),
    );
    expect(error.message).toBe('the download timed out');
  });
});
