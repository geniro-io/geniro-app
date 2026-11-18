import { describe, expect, it } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { CommandCenterInstructionsPush } from './command-center-instructions-push';

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

describe('CommandCenterInstructionsPush', () => {
  it('PUTs the instructions to the daemon with the launch token', async () => {
    const http = recordingFetch();
    await new CommandCenterInstructionsPush(
      () => undefined,
      http.fetchImpl,
    ).push(HANDLE, { instructions: 'Lead with the blocked threads.' });

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe(
      'http://127.0.0.1:47615/v1/command-center/instructions',
    );
    expect(call?.init.method).toBe('PUT');
    expect(call?.init.headers).toMatchObject({
      authorization: 'Bearer launch-token',
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      instructions: 'Lead with the blocked threads.',
    });
  });

  it('sends only instructions the daemon does not already hold', async () => {
    const http = recordingFetch();
    const push = new CommandCenterInstructionsPush(
      () => undefined,
      http.fetchImpl,
    );
    await push.push(HANDLE, { instructions: '' });

    await push.pushIfChanged(HANDLE, { instructions: '' });
    await push.pushIfChanged(HANDLE, { instructions: 'Keep replies short.' });

    expect(http.calls).toHaveLength(2);
    expect(JSON.parse(String(http.calls[1]?.init.body))).toEqual({
      instructions: 'Keep replies short.',
    });
  });

  it('names the refused value and retries it on the next write', async () => {
    const reports: string[] = [];
    const refusing = recordingFetch(400);
    const push = new CommandCenterInstructionsPush(
      (m) => reports.push(m),
      refusing.fetchImpl,
    );

    await push.push(HANDLE, { instructions: '' });
    await push.pushIfChanged(HANDLE, { instructions: '' });

    expect(reports[0]).toContain(
      'the daemon refused the command center instructions (400)',
    );
    expect(refusing.calls).toHaveLength(2);
  });
});
