import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  DISCARD_PARTIALS,
  failureReasonOf,
  modelFolderName,
  PAUSE_DOWNLOAD,
  readyModels,
  releaseBaseUrl,
  SearchModelDownloader,
  type SearchModelManifest,
} from './search-model-downloader';

const MODEL_BYTES = Buffer.from('m'.repeat(4000));
const TOKENIZER_BYTES = Buffer.from('{"t":1}'.repeat(500));

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestOf(files: Record<string, Buffer>): SearchModelManifest {
  return {
    id: 'test-model',
    repo: 'example/test-model',
    revision: 'abcdef1234567890',
    tag: 'model-test-abcdef1',
    dim: 4,
    files: Object.entries(files).map(([name, bytes]) => ({
      name,
      source: `onnx/${name}`,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
}

interface FakeRelease {
  baseUrl: string;
  requests: { path: string; range: string | undefined }[];
  close(): Promise<void>;
}

/**
 * A loopback release: serves `files` by name and `SHA256SUMS.txt`, honours a
 * `Range` header, and answers `hang` names with a partial body that never ends.
 */
async function serveRelease(
  files: Record<string, Buffer>,
  options: {
    sums?: string;
    status?: number;
    hang?: string[];
  } = {},
): Promise<FakeRelease> {
  const requests: FakeRelease['requests'] = [];
  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const name = decodeURIComponent((req.url ?? '').slice(1));
      const range = req.headers.range;
      requests.push({ path: name, range });
      if (name === 'SHA256SUMS.txt') {
        if (options.status !== undefined) {
          res.writeHead(options.status).end();
          return;
        }
        res.writeHead(200).end(options.sums);
        return;
      }
      const body = files[name];
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      if (options.hang?.includes(name)) {
        res.writeHead(200, { 'content-length': String(body.length) });
        res.write(body.subarray(0, 500));
        return;
      }
      const start = /^bytes=(\d+)-$/.exec(range ?? '')?.[1];
      if (start !== undefined) {
        const from = Number(start);
        res.writeHead(206, {
          'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
          'content-length': String(body.length - from),
        });
        res.end(body.subarray(from));
        return;
      }
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function sumsOf(files: Record<string, Buffer>): string {
  return Object.entries(files)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
    .join('\n');
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('the download was expected to fail');
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`${path} never appeared`);
}

describe('SearchModelDownloader', () => {
  let root: string;
  let modelsDir: string;
  let release: FakeRelease | null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'search-model-'));
    modelsDir = join(root, 'models');
    release = null;
  });

  afterEach(async () => {
    await release?.close();
    await rm(root, { recursive: true, force: true });
  });

  function folderOf(manifest: SearchModelManifest): string {
    return join(modelsDir, modelFolderName(manifest));
  }

  it('resumes a partial file with a Range request and verifies the whole file', async () => {
    const files = {
      'model.bin': MODEL_BYTES,
      'tokenizer.json': TOKENIZER_BYTES,
    };
    const manifest = manifestOf(files);
    release = await serveRelease(files, { sums: sumsOf(files) });
    const dir = folderOf(manifest);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.bin.part'), MODEL_BYTES.subarray(0, 1000));

    await new SearchModelDownloader({
      baseUrl: release.baseUrl,
      modelsDir,
    }).download(manifest, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(readFileSync(join(dir, 'model.bin'))).toEqual(MODEL_BYTES);
    expect(release.requests.find((r) => r.path === 'model.bin')?.range).toBe(
      'bytes=1000-',
    );
  });

  it('does not download a file that is already complete', async () => {
    const files = {
      'model.bin': MODEL_BYTES,
      'tokenizer.json': TOKENIZER_BYTES,
    };
    const manifest = manifestOf(files);
    release = await serveRelease(files, { sums: sumsOf(files) });
    const dir = folderOf(manifest);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model.bin'), MODEL_BYTES);

    await new SearchModelDownloader({
      baseUrl: release.baseUrl,
      modelsDir,
    }).download(manifest, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(release.requests.map((r) => r.path)).not.toContain('model.bin');
    expect(readFileSync(join(dir, 'tokenizer.json'))).toEqual(TOKENIZER_BYTES);
  });

  it('writes ready.json once every file is verified', async () => {
    const files = {
      'model.bin': MODEL_BYTES,
      'tokenizer.json': TOKENIZER_BYTES,
    };
    const manifest = manifestOf(files);
    release = await serveRelease(files, { sums: sumsOf(files) });

    await new SearchModelDownloader({
      baseUrl: release.baseUrl,
      modelsDir,
    }).download(manifest, {
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });

    expect(await readyModels(modelsDir, 'test-model')).toEqual([
      {
        id: 'test-model',
        revision: 'abcdef1234567890',
        dim: 4,
        dir: folderOf(manifest),
      },
    ]);
  });

  it('refuses a missing checksum list as not published', async () => {
    const files = { 'model.bin': MODEL_BYTES };
    release = await serveRelease(files, { status: 404 });

    const err = await rejectionOf(
      new SearchModelDownloader({
        baseUrl: release.baseUrl,
        modelsDir,
      }).download(manifestOf(files), {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    );

    expect(failureReasonOf(err)).toBe('not-published');
  });

  it('refuses a checksum list that disagrees with the manifest before fetching any file', async () => {
    const files = { 'model.bin': MODEL_BYTES };
    release = await serveRelease(files, {
      sums: `${'0'.repeat(64)}  model.bin`,
    });

    const err = await rejectionOf(
      new SearchModelDownloader({
        baseUrl: release.baseUrl,
        modelsDir,
      }).download(manifestOf(files), {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    );

    expect(failureReasonOf(err)).toBe('checksum');
    expect(release.requests.map((r) => r.path)).toEqual(['SHA256SUMS.txt']);
  });

  it('a file that fails its checksum loses only its own partial file', async () => {
    const manifest = manifestOf({
      'model.bin': MODEL_BYTES,
      'tokenizer.json': TOKENIZER_BYTES,
    });
    const served = {
      'model.bin': MODEL_BYTES,
      'tokenizer.json': Buffer.from('x'.repeat(TOKENIZER_BYTES.length)),
    };
    release = await serveRelease(served, {
      sums: sumsOf({
        'model.bin': MODEL_BYTES,
        'tokenizer.json': TOKENIZER_BYTES,
      }),
    });
    const dir = folderOf(manifest);

    const err = await rejectionOf(
      new SearchModelDownloader({
        baseUrl: release.baseUrl,
        modelsDir,
      }).download(manifest, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    );

    expect(failureReasonOf(err)).toBe('checksum');
    expect(existsSync(join(dir, 'tokenizer.json.part'))).toBe(false);
    expect(readFileSync(join(dir, 'model.bin'))).toEqual(MODEL_BYTES);
    expect(existsSync(join(dir, 'ready.json'))).toBe(false);
  });

  it('a cancel deletes every partial file', async () => {
    const files = {
      'model.bin': MODEL_BYTES,
      'tokenizer.json': TOKENIZER_BYTES,
    };
    const manifest = manifestOf(files);
    release = await serveRelease(files, {
      sums: sumsOf(files),
      hang: ['model.bin'],
    });
    const dir = folderOf(manifest);
    const controller = new AbortController();
    const running = new SearchModelDownloader({
      baseUrl: release.baseUrl,
      modelsDir,
    }).download(manifest, {
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await waitForFile(join(dir, 'model.bin.part'));
    controller.abort(DISCARD_PARTIALS);
    await rejectionOf(running);

    expect(
      readdirOrEmpty(dir).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
  });

  it('a pause keeps the partial file for the next attempt', async () => {
    const files = { 'model.bin': MODEL_BYTES };
    const manifest = manifestOf(files);
    release = await serveRelease(files, {
      sums: sumsOf(files),
      hang: ['model.bin'],
    });
    const dir = folderOf(manifest);
    const controller = new AbortController();
    const running = new SearchModelDownloader({
      baseUrl: release.baseUrl,
      modelsDir,
    }).download(manifest, {
      signal: controller.signal,
      onProgress: () => undefined,
    });

    await waitForFile(join(dir, 'model.bin.part'));
    controller.abort(PAUSE_DOWNLOAD);
    await rejectionOf(running);

    expect(existsSync(join(dir, 'model.bin.part'))).toBe(true);
  });

  it('a full disk is refused before any file is fetched', async () => {
    const files = { 'model.bin': MODEL_BYTES };
    release = await serveRelease(files, { sums: sumsOf(files) });

    const err = await rejectionOf(
      new SearchModelDownloader({
        baseUrl: release.baseUrl,
        modelsDir,
        availableBytes: async () => 100,
      }).download(manifestOf(files), {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    );

    expect(failureReasonOf(err)).toBe('disk-full');
    expect(release.requests.map((r) => r.path)).toEqual(['SHA256SUMS.txt']);
  });

  it('packaged builds always read the pinned release, whatever the override says', () => {
    const manifest = manifestOf({ 'model.bin': MODEL_BYTES });

    expect(
      releaseBaseUrl(manifest, {
        isPackaged: true,
        override: 'http://127.0.0.1:9/',
      }),
    ).toBe(
      `https://github.com/geniro-io/geniro-app/releases/download/${manifest.tag}/`,
    );
    expect(
      releaseBaseUrl(manifest, {
        isPackaged: false,
        override: 'http://127.0.0.1:9',
      }),
    ).toBe('http://127.0.0.1:9/');
  });
});

function readdirOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
