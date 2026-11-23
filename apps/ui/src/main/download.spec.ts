import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DownloadHttpError,
  type DownloadProgress,
  DownloadStalledError,
  downloadTo,
  fetchText,
  parseChecksums,
} from './download';

/**
 * A loopback server stands in for the release host: every test answers each
 * request through {@link handle}, so what the client sends (its `Range`) and
 * what it does with the answer are both observable. Nothing here is mocked.
 */
const PAYLOAD = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));

function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let root: string;
let server: Server;
let base: string;
let handle: (req: IncomingMessage, res: ServerResponse) => void;
let ranges: (string | undefined)[];

function urlOf(path: string): string {
  return `${base}${path}`;
}

/** Answer in full, then say nothing more: the client sees a stalled transfer. */
function sendFirstChunkThenHang(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
  res.write(PAYLOAD.subarray(0, 1024));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'geniro-download-spec-'));
  ranges = [];
  handle = (req, res) => {
    ranges.push(req.headers.range);
    res.writeHead(500).end();
  };
  server = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await rm(root, { recursive: true, force: true });
});

describe('downloadTo', () => {
  it('streams the whole file and returns the digest of what it wrote', async () => {
    handle = (req, res) => {
      ranges.push(req.headers.range);
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    };
    const dest = join(root, 'model.bin');
    const progress: DownloadProgress[] = [];

    const digest = await downloadTo(urlOf('/model.bin'), dest, {
      onProgress: (p) => progress.push(p),
    });

    expect(digest).toBe(digestOf(PAYLOAD));
    expect(await readFile(dest)).toEqual(PAYLOAD);
    expect(progress.at(-1)).toEqual({
      fraction: 1,
      receivedBytes: PAYLOAD.length,
      totalBytes: PAYLOAD.length,
    });
  });

  it('overwrites an existing file and sends no Range when resume is off', async () => {
    const dest = join(root, 'model.bin');
    await writeFile(dest, Buffer.alloc(100_000, 0xff));
    handle = (req, res) => {
      ranges.push(req.headers.range);
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    };

    expect(await downloadTo(urlOf('/model.bin'), dest)).toBe(digestOf(PAYLOAD));
    expect(ranges).toEqual([undefined]);
    expect(await readFile(dest)).toEqual(PAYLOAD);
  });

  it('resumes a partial file with a Range request and digests the whole file', async () => {
    const head = PAYLOAD.subarray(0, 100_000);
    const dest = join(root, 'model.bin');
    await writeFile(dest, head);
    handle = (req, res) => {
      ranges.push(req.headers.range);
      res.writeHead(206, {
        'content-range': `bytes ${head.length}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
        'content-length': String(PAYLOAD.length - head.length),
      });
      res.end(PAYLOAD.subarray(head.length));
    };
    const progress: DownloadProgress[] = [];

    const digest = await downloadTo(urlOf('/model.bin'), dest, {
      resume: true,
      onProgress: (p) => progress.push(p),
    });

    expect(ranges).toEqual([`bytes=${head.length}-`]);
    expect(digest).toBe(digestOf(PAYLOAD));
    expect(await readFile(dest)).toEqual(PAYLOAD);
    expect(progress[0]!.receivedBytes).toBeGreaterThan(head.length);
    expect(progress.at(-1)).toEqual({
      fraction: 1,
      receivedBytes: PAYLOAD.length,
      totalBytes: PAYLOAD.length,
    });
  });

  it('starts over when the server ignores the Range and answers in full', async () => {
    const dest = join(root, 'model.bin');
    await writeFile(dest, Buffer.alloc(100_000, 0xff));
    handle = (req, res) => {
      ranges.push(req.headers.range);
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    };

    expect(await downloadTo(urlOf('/model.bin'), dest, { resume: true })).toBe(
      digestOf(PAYLOAD),
    );
    expect(ranges).toEqual(['bytes=100000-']);
    expect(await readFile(dest)).toEqual(PAYLOAD);
  });

  it('takes a 416 as complete when the server reports the same length', async () => {
    const dest = join(root, 'model.bin');
    await writeFile(dest, PAYLOAD);
    handle = (req, res) => {
      ranges.push(req.headers.range);
      res.writeHead(416, {
        'content-range': `bytes */${PAYLOAD.length}`,
      });
      res.end();
    };

    expect(await downloadTo(urlOf('/model.bin'), dest, { resume: true })).toBe(
      digestOf(PAYLOAD),
    );
    expect(ranges).toEqual([`bytes=${PAYLOAD.length}-`]);
  });

  it('restarts from zero when a 416 reports a different length', async () => {
    const dest = join(root, 'model.bin');
    await writeFile(dest, PAYLOAD.subarray(0, 1000));
    handle = (req, res) => {
      ranges.push(req.headers.range);
      if (req.headers.range) {
        res.writeHead(416, {
          'content-range': `bytes */${PAYLOAD.length + 5}`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    };

    expect(await downloadTo(urlOf('/model.bin'), dest, { resume: true })).toBe(
      digestOf(PAYLOAD),
    );
    expect(ranges).toEqual(['bytes=1000-', undefined]);
    expect(await readFile(dest)).toEqual(PAYLOAD);
  });

  it('answers a non-2xx status with DownloadHttpError carrying the status', async () => {
    handle = (_req, res) => {
      res.writeHead(404).end();
    };

    const failure = await downloadTo(
      urlOf('/missing.bin'),
      join(root, 'missing.bin'),
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(DownloadHttpError);
    expect(failure).toMatchObject({ status: 404 });
    await expect(fetchText(urlOf('/SHA256SUMS.txt'))).rejects.toBeInstanceOf(
      DownloadHttpError,
    );
  });

  it('aborts a download that goes silent with DownloadStalledError', async () => {
    handle = sendFirstChunkThenHang;
    const started = Date.now();

    await expect(
      downloadTo(urlOf('/model.bin'), join(root, 'model.bin'), {
        stallTimeoutMs: 200,
      }),
    ).rejects.toBeInstanceOf(DownloadStalledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('keeps a slow transfer alive while bytes keep arriving inside the stall window', async () => {
    const chunk = 60_000;
    handle = (_req, res) => {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(PAYLOAD.subarray(sent, sent + chunk));
        sent += chunk;
        if (sent >= PAYLOAD.length) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on('close', () => clearInterval(timer));
    };

    expect(
      await downloadTo(urlOf('/model.bin'), join(root, 'model.bin'), {
        stallTimeoutMs: 300,
      }),
    ).toBe(digestOf(PAYLOAD));
  });

  it("rejects with the caller's abort reason and leaves the partial file in place", async () => {
    handle = sendFirstChunkThenHang;
    const dest = join(root, 'model.bin');
    const reason = new Error('the user cancelled');
    const controller = new AbortController();

    await expect(
      downloadTo(urlOf('/model.bin'), dest, {
        signal: controller.signal,
        onProgress: () => controller.abort(reason),
      }),
    ).rejects.toBe(reason);

    const partial = await readFile(dest);
    expect(partial.length).toBeLessThanOrEqual(1024);
    expect(partial).toEqual(PAYLOAD.subarray(0, partial.length));
  });
});

describe('parseChecksums', () => {
  it('reads shasum output, including binary-mode entries', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    const digests = parseChecksums(
      `${a}  Geniro-1.4.0-arm64-mac.zip\n${b} *Geniro-1.4.0-arm64.dmg\n`,
    );

    expect(digests.get('Geniro-1.4.0-arm64-mac.zip')).toBe(a);
    expect(digests.get('Geniro-1.4.0-arm64.dmg')).toBe(b);
  });

  it('skips lines that are not digests rather than throwing', () => {
    const digests = parseChecksums(
      `# a comment\n\nnot-a-digest  file.zip\n${'c'.repeat(64)}  real.zip\n`,
    );

    expect([...digests.keys()]).toEqual(['real.zip']);
  });
});
