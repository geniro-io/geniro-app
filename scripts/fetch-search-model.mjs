// Dev only, never shipped. Usage: node scripts/fetch-search-model.mjs [--dir <path>] [--serve [--port <n>]]
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const CHECKSUMS = 'SHA256SUMS.txt';
const DEFAULT_PORT = 47900;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(
  root,
  'apps/ui/src/main/search-model/search-model.manifest.json',
);

function parseArgs(argv) {
  const options = { dir: null, serve: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--serve') {
      options.serve = true;
    } else if (arg === '--dir' || arg === '--port') {
      i += 1;
      if (argv[i] === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      if (arg === '--dir') {
        options.dir = argv[i];
      } else {
        options.port = Number(argv[i]);
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error(`invalid port: ${options.port}`);
  }
  return options;
}

function defaultDir(manifest) {
  return join(
    homedir(),
    'Library',
    'Caches',
    'geniro-dev',
    'search-model',
    `${manifest.id}-${manifest.revision.slice(0, 7)}`,
  );
}

async function sha256Of(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function problemWith(path, file) {
  const { size } = await stat(path);
  if (size !== file.bytes) {
    return `${size} bytes, the manifest says ${file.bytes}`;
  }
  const digest = await sha256Of(path);
  return digest === file.sha256
    ? null
    : `sha256 ${digest}, the manifest says ${file.sha256}`;
}

async function isCached(path, file) {
  try {
    return (await problemWith(path, file)) === null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function download(url, file, target) {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${file.name}: HTTP ${response.status} from ${url}`);
  }
  const part = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
  const problem = await problemWith(part, file);
  if (problem !== null) {
    await rm(part, { force: true });
    throw new Error(`${file.name}: downloaded file has ${problem}`);
  }
  await rename(part, target);
}

async function ensureFiles(manifest, dir) {
  await mkdir(dir, { recursive: true });
  const base = `https://huggingface.co/${manifest.repo}/resolve/${manifest.revision}`;
  for (const file of manifest.files) {
    const target = join(dir, file.name);
    if (await isCached(target, file)) {
      console.log(`cached     ${file.name}`);
      continue;
    }
    console.log(`downloading ${file.name} (${file.bytes} bytes)`);
    await download(`${base}/${file.source}`, file, target);
    console.log(`verified   ${file.name}`);
  }
  const lines = manifest.files.map((file) => `${file.sha256}  ${file.name}\n`);
  await writeFile(join(dir, CHECKSUMS), lines.join(''));
  console.log(`wrote      ${join(dir, CHECKSUMS)}`);
}

function nameOf(url) {
  try {
    return decodeURIComponent(
      new URL(url, 'http://127.0.0.1').pathname.slice(1),
    );
  } catch {
    return '';
  }
}

function parseRange(header, size) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (match === null) {
    return null;
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start > end) {
    return 'unsatisfiable';
  }
  return { start, end };
}

async function respond(dir, served, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const name = nameOf(request.url);
  if (!served.has(name)) {
    response.writeHead(404).end();
    return;
  }
  const path = join(dir, name);
  const { size } = await stat(path);
  const range = parseRange(request.headers.range, size);
  if (range === 'unsatisfiable') {
    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': 'application/octet-stream',
  };
  if (range !== null) {
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  response.writeHead(range === null ? 200 : 206, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await pipeline(createReadStream(path, { start, end }), response);
}

function serve(dir, names, port) {
  const served = new Set([...names, CHECKSUMS]);
  const server = createServer((request, response) => {
    respond(dir, served, request, response).catch((error) => {
      console.error(error.message);
      response.destroy();
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`GENIRO_SEARCH_MODEL_URL=http://127.0.0.1:${port}/`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const dir =
    options.dir === null ? defaultDir(manifest) : resolve(options.dir);
  await ensureFiles(manifest, dir);
  if (options.serve) {
    serve(
      dir,
      manifest.files.map((file) => file.name),
      options.port,
    );
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
