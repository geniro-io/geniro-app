import { describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import {
  describeLoadFailure,
  ERR_ABORTED,
  flushMainLogs,
  isRealLoadFailure,
  reportMainLog,
} from './window-diagnostics';

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-01-01T00:00:00.000Z',
};

const failure = (over: Partial<Parameters<typeof isRealLoadFailure>[0]> = {}) =>
  ({
    errorCode: -6,
    errorDescription: 'ERR_FILE_NOT_FOUND',
    url: 'file:///app/index.html',
    isMainFrame: true,
    ...over,
  }) as Parameters<typeof isRealLoadFailure>[0];

describe('isRealLoadFailure', () => {
  it('is true for a failed top document', () => {
    expect(isRealLoadFailure(failure())).toBe(true);
  });

  it('ignores ERR_ABORTED, which is what an ordinary redirect or HMR reload looks like', () => {
    // Without this the recovery reload fires against a load that was already
    // being replaced, and every dev hot-reload reports the app as broken.
    expect(isRealLoadFailure(failure({ errorCode: ERR_ABORTED }))).toBe(false);
  });

  it('ignores a sub-resource, which is not the app failing to open', () => {
    expect(isRealLoadFailure(failure({ isMainFrame: false }))).toBe(false);
  });
});

describe('describeLoadFailure', () => {
  it('carries the URL, Electron’s own words and the code', () => {
    // All three: the code alone is a number nobody remembers, and the
    // description alone does not say WHAT failed to load.
    const line = describeLoadFailure(failure());
    expect(line).toContain('file:///app/index.html');
    expect(line).toContain('ERR_FILE_NOT_FOUND');
    expect(line).toContain('-6');
  });
});

describe('reportMainLog', () => {
  it('posts the line to the daemon’s ui channel, marked as coming from main', async () => {
    // `from: 'main'` is load-bearing: the channel already carries the
    // RENDERER's errors, and the two processes see different halves of the
    // same window — a reader has to be able to tell which one is talking.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await reportMainLog(
      HANDLE,
      'error',
      'the renderer failed to load',
      { kind: 'renderer-load-failed' },
      fetchImpl as unknown as typeof fetch,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('http://127.0.0.1:47615/v1/diagnostics/ui-log');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    );
    expect(JSON.parse(String(init.body))).toEqual({
      level: 'error',
      message: 'the renderer failed to load',
      context: { kind: 'renderer-load-failed', from: 'main' },
    });
  });

  it('holds a report raised before the daemon exists, and sends it on the flush', async () => {
    // The window is created BEFORE `ensureDaemon()`, so the very first window's
    // line — the one saying what the app opened with — is precisely the one
    // that would always be dropped without the buffer.
    const fetchImpl = vi.fn(async () => new Response(null, { status: 201 }));
    await reportMainLog(
      null,
      'error',
      'the renderer failed to load',
      { kind: 'renderer-load-failed' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    await flushMainLogs(HANDLE, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(init.body))).toMatchObject({
      message: 'the renderer failed to load',
    });

    // Drained, not replayed: a second flush must not repeat the line.
    await flushMainLogs(HANDLE, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('drops the buffer when the daemon never arrives, rather than holding it forever', async () => {
    const fetchImpl = vi.fn();
    await reportMainLog(
      null,
      'info',
      'loaded',
      {},
      fetchImpl as unknown as typeof fetch,
    );
    await flushMainLogs(null, fetchImpl as unknown as typeof fetch);
    await flushMainLogs(HANDLE, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows its own failure rather than becoming a second one', async () => {
    // This runs on error paths. A rejection here would be a new uncaught error
    // raised by the thing reporting the first.
    const fetchImpl = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(
      reportMainLog(
        HANDLE,
        'error',
        'x',
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();
  });
});
