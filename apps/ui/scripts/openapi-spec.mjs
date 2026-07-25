/**
 * Resolve the daemon's OpenAPI document and write it to a file.
 *
 * The sibling Geniro web app points `generate:api` at a fixed
 * `http://localhost:5000/swagger-api-json`, but this daemon is local-first: it
 * negotiates its port, mints a fresh bearer token per launch, and token-gates
 * `/swagger-api*`. So the spec is resolved in three steps, first match wins:
 *
 *   1. `GENIRO_SWAGGER_URL` (+ optional `GENIRO_SWAGGER_TOKEN`) — an explicit
 *      override, the closest analogue to the sibling's flow.
 *   2. The pidfile a running daemon wrote (`<userData>/daemon.json`), which
 *      carries host, port and the launch token. Zero setup while `pnpm dev` or
 *      the packaged app is up.
 *   3. A throwaway daemon booted from `apps/daemon/dist/main.js` against a
 *      temp userData dir, queried, then shut down — so codegen works with
 *      nothing running and touches none of the user's data.
 *
 * Usage: node scripts/openapi-spec.mjs <output-file>
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(UI_DIR, '..', '..');
const DAEMON_ENTRY = join(REPO_ROOT, 'apps', 'daemon', 'dist', 'main.js');
const ELECTRON_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'electron');

/** Where the packaged app and `pnpm dev` keep the daemon pidfile. */
const USER_DATA_CANDIDATES = [
  process.env.GENIRO_USER_DATA,
  join(homedir(), 'Library', 'Application Support', 'Geniro'),
  join(homedir(), '.geniro'),
].filter(Boolean);

/** Give a cold boot room for the schema sync; a warm one is ~1s. */
const BOOT_TIMEOUT_MS = 60_000;

const fetchSpec = async (baseUrl, token) => {
  const res = await fetch(`${baseUrl}/swagger-api-json`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`GET ${baseUrl}/swagger-api-json → ${res.status}`);
  }
  return await res.json();
};

const readPidfile = () => {
  for (const dir of USER_DATA_CANDIDATES) {
    try {
      const info = JSON.parse(readFileSync(join(dir, 'daemon.json'), 'utf8'));
      if (info?.port && info?.token) {
        return info;
      }
    } catch {
      // No pidfile in this candidate — try the next.
    }
  }
  return null;
};

/** Ask a daemon we did not start; a stale pidfile just falls through. */
const fromRunningDaemon = async () => {
  const info = readPidfile();
  if (!info) {
    return null;
  }
  const baseUrl = `http://${info.host ?? '127.0.0.1'}:${info.port}`;
  try {
    const spec = await fetchSpec(baseUrl, info.token);
    console.log(`openapi: read from the running daemon on ${baseUrl}`);
    return spec;
  } catch (err) {
    console.warn(`openapi: running daemon unusable (${String(err)}) — booting one`);
    return null;
  }
};

/**
 * Boot the built daemon under Electron's node (its `better-sqlite3` is built
 * for Electron's ABI — see `pnpm rebuild:native`), read the spec, shut it down.
 */
const fromThrowawayDaemon = async () => {
  const userData = mkdtempSync(join(tmpdir(), 'geniro-openapi-'));
  const child = spawn(ELECTRON_BIN, [DAEMON_ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      GENIRO_USER_DATA: userData,
      // No GENIRO_PORT: the daemon's own portFallback negotiates a free one if
      // the default is taken, and the pidfile reports what it actually bound.
      GENIRO_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  try {
    const port = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error('daemon did not report ready in time')),
        BOOT_TIMEOUT_MS,
      );
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        buffered += String(chunk);
        const match = buffered.match(/GENIRO_DAEMON_READY (\{.*\})/);
        if (match) {
          clearTimeout(timer);
          resolveReady(JSON.parse(match[1]).port);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        rejectReady(
          new Error(
            `daemon exited with code ${code}\n${stderr.join('').slice(-2000)}`,
          ),
        );
      });
    });

    const { token } = JSON.parse(
      readFileSync(join(userData, 'daemon.json'), 'utf8'),
    );
    const spec = await fetchSpec(`http://127.0.0.1:${port}`, token);
    console.log(`openapi: read from a throwaway daemon on port ${port}`);
    return spec;
  } finally {
    child.kill('SIGTERM');
    rmSync(userData, { recursive: true, force: true });
  }
};

const resolveSpec = async () => {
  const url = process.env.GENIRO_SWAGGER_URL;
  if (url) {
    const base = url.replace(/\/swagger-api-json\/?$/, '');
    console.log(`openapi: read from GENIRO_SWAGGER_URL (${base})`);
    return await fetchSpec(base, process.env.GENIRO_SWAGGER_TOKEN);
  }
  return (await fromRunningDaemon()) ?? (await fromThrowawayDaemon());
};

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/openapi-spec.mjs <output-file>');
  process.exit(1);
}

try {
  const spec = await resolveSpec();
  const operations = Object.values(spec.paths ?? {}).reduce(
    (total, methods) => total + Object.keys(methods).length,
    0,
  );
  writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(
    `openapi: ${operations} operations, ` +
      `${Object.keys(spec.components?.schemas ?? {}).length} schemas → ${out}`,
  );
} catch (err) {
  console.error(`openapi: could not resolve the daemon spec — ${String(err)}`);
  console.error(
    'Build the daemon first (`pnpm build`) or start the app, then retry.',
  );
  process.exit(1);
}
