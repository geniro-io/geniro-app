import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { DaemonInfo } from '../utils/handshake';

const DAEMON_DIR = join(__dirname, '..', '..');
export const BOOT_TIMEOUT_MS = 90_000;
const OUTPUT_TAIL = 3000;

export interface BootedDaemon {
  child: ChildProcess;
  info: DaemonInfo;
  /** Everything the daemon printed so far, both streams. */
  output(): string;
}

/**
 * Spawns the REAL daemon from source, exactly as `pnpm daemon:dev` does, on
 * `userData`, and resolves once it prints `GENIRO_DAEMON_READY`. A child process
 * rather than an in-suite container: the suite's transform carries no decorator
 * metadata, and the swc-node loader `daemon:dev` uses does.
 */
export async function bootDaemon(userData: string): Promise<BootedDaemon> {
  let output = '';
  const child = spawn(
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
      // Detached once ready, so a case's own stop is not read as a failed boot.
      child.off('exit', onExit);
      child.off('error', onError);
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
  });

  return {
    child,
    info: JSON.parse(
      readFileSync(join(userData, 'daemon.json'), 'utf8'),
    ) as DaemonInfo,
    output: () => output,
  };
}

/** SIGTERMs a booted daemon and waits for it to exit. */
export async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  child.kill('SIGTERM');
  await exited;
}
