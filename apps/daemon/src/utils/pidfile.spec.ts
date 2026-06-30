import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DaemonInfo } from './handshake';
import { mintToken, removePidfile, writePidfile } from './pidfile';

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
    startedAt: new Date(0).toISOString(),
  });

  it('mints unique 64-char hex tokens', () => {
    const a = mintToken();
    const b = mintToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
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
