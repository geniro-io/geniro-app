import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { ResourceAlertsConfigPush } from './resource-alerts-config-push';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};

const GIB = 1024 ** 3;

describe('ResourceAlertsConfigPush', () => {
  it('PUTs the resource alert settings to the daemon with the launch token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const settings = {
      enabled: false,
      threadMemoryBytes: 4 * GIB,
      growthBytesPerMinute: GIB,
      minFreeDiskBytes: 20 * GIB,
    };

    await new ResourceAlertsConfigPush(() => undefined, fetchImpl).push(
      HANDLE,
      settings,
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/resource-alerts/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual(settings);
  });
});
