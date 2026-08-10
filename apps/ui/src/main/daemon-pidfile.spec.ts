import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DAEMON_LOOPBACK_HOST,
  type DaemonInfo,
  parseDaemonInfo,
  readDaemonInfo,
  stampEntry,
} from './daemon-pidfile';

describe('the entry stamp — the twin parser’s only mechanical link', () => {
  it('parses the exact JSON the daemon writes', () => {
    // The daemon builds this object in `apps/daemon/src/utils/handshake.ts`
    // `stampEntry` and it reaches here through JSON. If either side renames a
    // key, every daemon reads as unstamped and is replaced on every launch —
    // and nothing else in either suite would notice.
    const parsed = parseDaemonInfo({
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      entry: { path: '/bundle/daemon/dist/main.js', mtimeMs: 17, size: 8508 },
      startedAt: '2026-08-10T00:00:00Z',
    });
    expect(parsed?.entry).toEqual({
      path: '/bundle/daemon/dist/main.js',
      mtimeMs: 17,
      size: 8508,
    });
  });

  it('round-trips a stamp this side produced through JSON', () => {
    const stamped = stampEntry('/bundle/daemon/dist/main.js', () => ({
      mtimeMs: 17,
      size: 8508,
    }));
    const wire: unknown = JSON.parse(JSON.stringify(stamped));
    expect(
      parseDaemonInfo({
        pid: 1,
        host: DAEMON_LOOPBACK_HOST,
        port: 4823,
        token: 't',
        version: '0.1.0',
        entry: wire,
        startedAt: '2026-08-10T00:00:00Z',
      })?.entry,
    ).toEqual(stamped);
  });

  it('reads a stamp with no usable path as no stamp at all', () => {
    // Not the same as a valid stamp with null numbers: a stamp naming no file
    // cannot be compared to anything, so it must not present as comparable.
    for (const entry of [null, 'x', {}, { path: '' }, { mtimeMs: 1 }]) {
      expect(
        parseDaemonInfo({
          pid: 1,
          host: DAEMON_LOOPBACK_HOST,
          port: 4823,
          token: 't',
          version: '0.1.0',
          entry,
          startedAt: '2026-08-10T00:00:00Z',
        })?.entry,
      ).toBeNull();
    }
  });

  it('nulls a non-finite mtime or size rather than carrying it through', () => {
    const parsed = parseDaemonInfo({
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      entry: { path: '/x/main.js', mtimeMs: 'soon', size: null },
      startedAt: '2026-08-10T00:00:00Z',
    });
    expect(parsed?.entry).toEqual({
      path: '/x/main.js',
      mtimeMs: null,
      size: null,
    });
  });

  it('still accepts a pidfile with no entry at all', () => {
    // A daemon older than the field. It must parse — it is a real running
    // daemon — and only the ADOPTION decision treats it as stale.
    const parsed = parseDaemonInfo({
      pid: 1,
      host: DAEMON_LOOPBACK_HOST,
      port: 4823,
      token: 't',
      version: '0.1.0',
      startedAt: '2026-08-10T00:00:00Z',
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.entry).toBeNull();
  });
});

function valid(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    pid: 123,
    host: DAEMON_LOOPBACK_HOST,
    port: 4823,
    token: 'token',
    version: '1.0.0',
    entry: null,
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
