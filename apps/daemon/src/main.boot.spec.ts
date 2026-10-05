import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DaemonInfo } from './utils/handshake';

/**
 * Boots the REAL daemon — the whole Nest container, from source, exactly as
 * `pnpm daemon:dev` does — and drives it from outside.
 *
 * Every other spec here builds the instance it tests by hand, so a break in
 * the framework underneath (a DI change, a lifecycle-order change, a library
 * pair that refuses to render the OpenAPI document) would ship green. A child process rather than an in-suite
 * container: this suite's transform carries no decorator metadata, and the
 * swc-node loader `daemon:dev` uses does, so no build step is needed.
 */

const DAEMON_DIR = join(__dirname, '..');
const BOOT_TIMEOUT_MS = 90_000;
const SOCKET_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL = 3000;

let child: ChildProcess;
let userData: string;
let info: DaemonInfo;
let output = '';
let readyListeners: () => void = () => undefined;

const base = () => `http://${info.host}:${info.port}`;
const auth = () => ({ authorization: `Bearer ${info.token}` });

/** Bounds a socket wait below the test's own timeout, so a hang names its step. */
function within<T>(promise: Promise<T>, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${step} within ${SOCKET_TIMEOUT_MS}ms`)),
      SOCKET_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'geniro-boot-spec-'));
  child = spawn(
    process.execPath,
    [
      '-r',
      '@swc-node/register',
      '-r',
      'tsconfig-paths/register',
      './src/main.ts',
    ],
    {
      cwd: DAEMON_DIR,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'development',
        TS_NODE_PROJECT: join(DAEMON_DIR, '..', '..', 'tsconfig.json'),
        GENIRO_USER_DATA: userData,
        GENIRO_PORT: '',
        // An orphan left by a killed test worker shuts itself down.
        GENIRO_IDLE_EXIT_MS: '60000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (chunk: Buffer) => (output += String(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => (output += String(chunk)));

  await new Promise<void>((resolve, reject) => {
    const settle = (error: Error | null) => {
      clearInterval(poll);
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const poll = setInterval(() => {
      if (output.includes('GENIRO_DAEMON_READY')) {
        settle(null);
      }
    }, 100);
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `daemon never became ready:\n${output.slice(-OUTPUT_TAIL)}`,
          ),
        ),
      BOOT_TIMEOUT_MS,
    );
    const onExit = (code: number | null) =>
      settle(
        new Error(
          `daemon exited (${code}) during boot:\n${output.slice(-OUTPUT_TAIL)}`,
        ),
      );
    const onError = (error: Error) => settle(error);
    child.once('exit', onExit);
    child.once('error', onError);
    // Detached once ready, so the SIGTERM case's own exit is not read as a
    // failed boot.
    readyListeners = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
  });
  readyListeners();
  info = JSON.parse(
    readFileSync(join(userData, 'daemon.json'), 'utf8'),
  ) as DaemonInfo;
}, BOOT_TIMEOUT_MS + 5_000);

afterAll(() => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  rmSync(userData, { recursive: true, force: true });
});

describe('the daemon boots and serves', () => {
  it('answers its readiness probe', async () => {
    const res = await fetch(`${base()}/health/check`);
    expect(res.status).toBe(200);
  });

  it('gates the REST API behind the launch token', async () => {
    expect((await fetch(`${base()}/v1/chats`)).status).toBe(403);
    expect(
      (await fetch(`${base()}/v1/chats`, { headers: auth() })).status,
    ).toBe(200);
  });

  it('renders the OpenAPI document — and only for the launch token', async () => {
    // Every mount the gate covers: the UI, both documents (siblings of the
    // UI path, not children) and the Scalar reference.
    for (const path of [
      '/swagger-api',
      '/swagger-api-json',
      '/swagger-api-yaml',
      '/swagger-api/reference',
    ]) {
      expect((await fetch(`${base()}${path}`)).status).toBe(403);
      const wrong = await fetch(`${base()}${path}`, {
        headers: { authorization: 'Bearer wrong' },
      });
      expect(wrong.status).toBe(403);
      expect(
        (await fetch(`${base()}${path}`, { headers: auth() })).status,
      ).toBe(200);
    }
    const res = await fetch(`${base()}/swagger-api-json`, { headers: auth() });
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths?: Record<string, unknown> };
    expect(Object.keys(doc.paths ?? {}).length).toBeGreaterThan(50);
  });

  it(
    'runs a gateway message handler for an authenticated socket',
    async () => {
      const socket: Socket = io(base(), {
        path: '/ws',
        auth: { token: info.token },
        transports: ['websocket'],
        reconnection: false,
      });
      const exceptions: unknown[] = [];
      socket.on('exception', (e: unknown) => exceptions.push(e));
      try {
        await within(
          new Promise<void>((resolve, reject) => {
            socket.once('connect', () => resolve());
            socket.once('connect_error', reject);
          }),
          'connect',
        );
        const echoed = await within(
          new Promise<unknown>((resolve) => {
            socket.once('echo', resolve);
            socket.emit('echo', { ping: 1 });
          }),
          'echo',
        );
        expect(echoed).toEqual({ ping: 1 });
        expect(exceptions).toEqual([]);
      } finally {
        socket.close();
      }
    },
    SOCKET_TIMEOUT_MS * 3,
  );

  it(
    'refuses a socket that presents the wrong token',
    async () => {
      const socket: Socket = io(base(), {
        path: '/ws',
        auth: { token: 'wrong' },
        transports: ['websocket'],
        reconnection: false,
      });
      try {
        const reason = await within(
          new Promise<string>((resolve) => {
            socket.once('disconnect', (why: string) => resolve(why));
          }),
          'disconnect',
        );
        expect(reason).toBe('io server disconnect');
      } finally {
        socket.close();
      }
    },
    SOCKET_TIMEOUT_MS * 2,
  );

  it('shuts down on SIGTERM and clears its pidfile and lock', async () => {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill('SIGTERM');
    await exited;
    expect(existsSync(join(userData, 'daemon.json'))).toBe(false);
    expect(existsSync(join(userData, 'daemon.lock'))).toBe(false);
  }, 15_000);
});
