import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DaemonInfo } from './handshake';
import { removePidfile, writeCrashMark, writePidfile } from './pidfile';

describe('pidfile', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-pidfile-'));
    path = join(dir, 'daemon.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sample = (pid: number): DaemonInfo => ({
    pid,
    host: '127.0.0.1',
    port: 47615,
    token: 'deadbeef',
    version: '0.1.0',
    entry: { path: '/bundle/daemon/dist/main.js', mtimeMs: 1, size: 2 },
    pidStartedAtMs: 1_786_000_000_000,
    startedAt: new Date(0).toISOString(),
  });

  it('writes the descriptor as JSON that reads back intact', () => {
    const info = sample(process.pid);
    writePidfile(path, info);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(info);
  });

  it('removePidfile removes an existing file and tolerates a missing one', () => {
    writePidfile(path, sample(process.pid));
    removePidfile(path);
    expect(existsSync(path)).toBe(false);
    expect(() => removePidfile(path)).not.toThrow();
  });
});

describe('writeCrashMark', () => {
  it('leaves the dying pid where the supervisor reads it, owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'geniro-crash-mark-'));
    try {
      writeCrashMark(dir, 4242);

      const path = join(dir, 'daemon-crashed');
      expect(readFileSync(path, 'utf8')).toBe('4242');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
