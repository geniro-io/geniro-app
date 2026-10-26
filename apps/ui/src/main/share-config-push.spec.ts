import { describe, expect, it } from 'vitest';

import type { DaemonHandle, SharingSettings } from '../shared/contracts';
import { ShareConfigPush } from './share-config-push';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};
const SHARING: SharingSettings = {
  destinations: [],
  defaultDestinationId: null,
  agentsMayShare: true,
  autoRevokeAfterDays: null,
};

function recordingFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('ShareConfigPush', () => {
  it('PUTs the settings to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new ShareConfigPush(() => undefined, http.fetchImpl).push(
      HANDLE,
      SHARING,
    );

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/shares/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual(SHARING);
  });

  it('sends nothing for a write that left the sharing settings as the daemon has them', async () => {
    const http = recordingFetch();
    const push = new ShareConfigPush(() => undefined, http.fetchImpl);
    await push.push(HANDLE, SHARING);

    await push.pushIfChanged(HANDLE, { ...SHARING });
    await push.pushIfChanged(HANDLE, { ...SHARING, agentsMayShare: false });

    expect(http.calls).toHaveLength(2);
  });

  it('reports a refusal and retries the same value on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new ShareConfigPush(
      (m) => reports.push(m),
      refusing.fetchImpl,
    );

    await push.push(HANDLE, SHARING);
    await push.pushIfChanged(HANDLE, SHARING);

    expect(reports[0]).toContain('refused the sharing settings (400)');
    expect(refusing.calls).toHaveLength(2);
  });

  it('waits for a daemon rather than failing when none is up', async () => {
    const http = recordingFetch();
    await new ShareConfigPush(() => undefined, http.fetchImpl).pushIfChanged(
      null,
      SHARING,
    );
    expect(http.calls).toHaveLength(0);
  });
});
