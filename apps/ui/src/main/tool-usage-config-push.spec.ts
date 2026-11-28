import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { ToolUsageConfigPush } from './tool-usage-config-push';

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

describe('ToolUsageConfigPush', () => {
  it('PUTs the retention to the daemon with the launch token, keep-forever as null', async () => {
    const http = recordingFetch();
    const push = new ToolUsageConfigPush(() => undefined, http.fetchImpl);

    await push.push(HANDLE, { toolCallLogRetentionDays: 90 });
    await push.pushIfChanged(HANDLE, { toolCallLogRetentionDays: null });

    expect(http.calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:47615/v1/stats/tool-usage/config',
      'http://127.0.0.1:47615/v1/stats/tool-usage/config',
    ]);
    expect(http.calls[0]?.init).toMatchObject({
      method: 'PUT',
      headers: { authorization: 'Bearer launch-token' },
    });
    expect(
      http.calls.map((call): unknown => JSON.parse(String(call.init.body))),
    ).toEqual([
      { toolCallLogRetentionDays: 90 },
      { toolCallLogRetentionDays: null },
    ]);
  });

  it('names the refused value', async () => {
    const reports: string[] = [];
    const push = new ToolUsageConfigPush(
      (m) => reports.push(m),
      recordingFetch(400).fetchImpl,
    );

    await push.push(HANDLE, { toolCallLogRetentionDays: 30 });

    expect(reports[0]).toContain(
      'the daemon refused the tool log retention (400)',
    );
  });
});
