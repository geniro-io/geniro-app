import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DaemonInfo } from './handshake';
import {
  isProcessAlive,
  mintToken,
  readPidfile,
  reconcilePidfile,
  removePidfile,
  writePidfile,
} from './pidfile';

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

  it('round-trips write → read', () => {
    const info = sample(process.pid);
    writePidfile(path, info);
    expect(readPidfile(path)).toEqual(info);
  });

  it('returns null for a missing or malformed pidfile', () => {
    expect(readPidfile(path)).toBeNull();
    writeFileSync(path, 'not json');
    expect(readPidfile(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: 1 }));
    expect(readPidfile(path)).toBeNull();
  });

  it('detects the current process as alive and a bogus pid as dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2_147_483_646)).toBe(false);
  });

  it('reconcile keeps a live descriptor', () => {
    writePidfile(path, sample(process.pid));
    expect(reconcilePidfile(path)?.pid).toBe(process.pid);
    expect(readPidfile(path)).not.toBeNull();
  });

  it('reconcile sweeps an orphaned (dead-pid) pidfile', () => {
    writePidfile(path, sample(2_147_483_646));
    expect(reconcilePidfile(path)).toBeNull();
    expect(readPidfile(path)).toBeNull();
  });

  it('removePidfile tolerates a missing file', () => {
    expect(() => removePidfile(path)).not.toThrow();
  });

  it('treats a pidfile claiming pid 0 as a dead orphan and sweeps it', () => {
    // process.kill(0, 0) targets the caller's own process group and succeeds,
    // so isProcessAlive(0) reports "alive" — a corrupt pidfile with pid:0 is
    // never swept and reconcile hands back a descriptor for a daemon that does
    // not exist (its port/token get reused against nothing).
    writePidfile(path, sample(0));
    expect(reconcilePidfile(path)).toBeNull();
    expect(readPidfile(path)).toBeNull();
  });

  it('treats a pidfile claiming a negative pid as a dead orphan and sweeps it', () => {
    // process.kill(-1, 0) broadcasts to every process the caller may signal and
    // succeeds, so isProcessAlive(-1) reports "alive". A negative-pid pidfile is
    // never reclaimed and reconcile reuses a non-existent daemon's descriptor.
    writePidfile(path, sample(-1));
    expect(reconcilePidfile(path)).toBeNull();
    expect(readPidfile(path)).toBeNull();
  });

  it('rejects a pidfile whose port is a non-integer (unbindable) value', () => {
    // typeof 47615.7 === 'number' passes the shape check, so a fractional port
    // round-trips as a valid DaemonInfo even though no socket can bind it.
    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        host: '127.0.0.1',
        port: 47615.7,
        token: 'deadbeef',
        version: '0.1.0',
        startedAt: new Date(0).toISOString(),
      }),
    );
    expect(readPidfile(path)).toBeNull();
  });
});
