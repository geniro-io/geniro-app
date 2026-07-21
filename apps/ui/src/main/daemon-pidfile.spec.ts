import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DAEMON_LOOPBACK_HOST,
  type DaemonInfo,
  parseDaemonInfo,
  readDaemonInfo,
} from './daemon-pidfile';

function valid(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 123,
    host: DAEMON_LOOPBACK_HOST,
    port: 4823,
    token: 'token',
    version: '1.0.0',
    startedAt: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

describe('parseDaemonInfo', () => {
  it('accepts the daemon contract loopback host', () => {
    expect(parseDaemonInfo(valid())).toEqual(valid());
  });

  it.each(['localhost', '::1', '192.168.1.10', 'example.com'])(
    'rejects non-contract host %s so bearer traffic cannot leave loopback',
    (host) => {
      expect(parseDaemonInfo(valid({ host }))).toBeNull();
    },
  );

  it('rejects malformed process and port coordinates', () => {
    expect(parseDaemonInfo(valid({ pid: 0 }))).toBeNull();
    expect(parseDaemonInfo(valid({ port: 65_536 }))).toBeNull();
  });

  it('rejects a non-integer pid', () => {
    expect(parseDaemonInfo(valid({ pid: 1.5 }))).toBeNull();
  });

  it('rejects an empty token — adopting it would 401 every bearer request', () => {
    expect(parseDaemonInfo(valid({ token: '' }))).toBeNull();
  });

  it('rejects a missing or non-string version', () => {
    const missingVersion: Partial<DaemonInfo> = { ...valid() };
    delete missingVersion.version;
    expect(parseDaemonInfo(missingVersion)).toBeNull();
    expect(parseDaemonInfo({ ...valid(), version: 100 })).toBeNull();
  });

  it('rejects a missing or non-string startedAt', () => {
    const missingStartedAt: Partial<DaemonInfo> = { ...valid() };
    delete missingStartedAt.startedAt;
    expect(parseDaemonInfo(missingStartedAt)).toBeNull();
    expect(
      parseDaemonInfo({ ...valid(), startedAt: 1_720_000_000_000 }),
    ).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(parseDaemonInfo(null)).toBeNull();
    // A JSON string of the right shape is still not the object itself.
    expect(parseDaemonInfo(JSON.stringify(valid()))).toBeNull();
  });
});

describe('readDaemonInfo', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'geniro-pidfile-spec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a valid pidfile (control for the null cases below)', () => {
    const path = join(dir, 'daemon.json');
    writeFileSync(path, JSON.stringify(valid()), 'utf8');

    expect(readDaemonInfo(path)).toEqual(valid());
  });

  it('returns null for an absent file', () => {
    expect(readDaemonInfo(join(dir, 'daemon.json'))).toBeNull();
  });

  it('returns null for a file containing invalid JSON', () => {
    const path = join(dir, 'daemon.json');
    writeFileSync(path, '{ pid: 123, oops', 'utf8');

    expect(readDaemonInfo(path)).toBeNull();
  });
});
