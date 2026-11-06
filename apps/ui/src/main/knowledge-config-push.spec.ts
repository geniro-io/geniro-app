import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { KnowledgeConfigPush } from './knowledge-config-push';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '0.0.0',
  startedAt: new Date(0).toISOString(),
};

function recordingFetch(status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('{}', { status }));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('KnowledgeConfigPush', () => {
  it('PUTs the knowledge settings to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new KnowledgeConfigPush(() => undefined, http.fetchImpl).push(
      HANDLE,
      { enabled: false, agentWrites: 'direct' },
    );

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe('http://127.0.0.1:47615/v1/knowledge/config');
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      enabled: false,
      agentWrites: 'direct',
    });
  });

  it('names the refused settings and retries them on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new KnowledgeConfigPush(
      (message) => reports.push(message),
      refusing.fetchImpl,
    );

    await push.push(HANDLE, { enabled: true, agentWrites: 'review' });
    await push.pushIfChanged(HANDLE, { enabled: true, agentWrites: 'review' });

    expect(reports[0]).toContain(
      'the daemon refused the knowledge settings (400)',
    );
    expect(refusing.calls).toHaveLength(2);
  });
});
