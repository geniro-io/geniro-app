import { describe, expect, it } from 'vitest';

import {
  DAEMON_LOOPBACK_HOST,
  type DaemonInfo,
  parseDaemonInfo,
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
});
