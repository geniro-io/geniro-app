import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { readFinishedTasks } from './finished-tasks';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
};

/** A daemon that answers every request with `status` and `body`. */
function answering(status: number, body: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFinishedTasks', () => {
  it('answers with the ids the daemon called finished', async () => {
    vi.stubGlobal('fetch', answering(200, { taskIds: ['t1'] }));

    await expect(readFinishedTasks(handle, ['t1', 't2'])).resolves.toEqual(
      new Set(['t1']),
    );
  });

  it('asks the finished route, with the launch token and the ids', async () => {
    const fetchMock = answering(200, { taskIds: [] });
    vi.stubGlobal('fetch', fetchMock);

    await readFinishedTasks(handle, ['t1', 't2']);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:47615/v1/tasks/finished');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    );
    expect(JSON.parse(init?.body as string) as unknown).toEqual({
      taskIds: ['t1', 't2'],
    });
  });

  // A reply naming a card this pass never asked about is not an answer to it,
  // and acting on one would collect a worktree nobody asked about.
  it('drops ids it never asked about', async () => {
    vi.stubGlobal('fetch', answering(200, { taskIds: ['t1', 'stranger', 7] }));

    await expect(readFinishedTasks(handle, ['t1'])).resolves.toEqual(
      new Set(['t1']),
    );
  });

  it('answers null when the daemon refuses the question', async () => {
    vi.stubGlobal('fetch', answering(400, { errorCode: 'BAD_REQUEST' }));

    await expect(readFinishedTasks(handle, ['t1'])).resolves.toBeNull();
  });

  it('answers null for a reply that is not the answer', async () => {
    vi.stubGlobal('fetch', answering(200, { taskIds: 't1' }));
    await expect(readFinishedTasks(handle, ['t1'])).resolves.toBeNull();

    vi.stubGlobal('fetch', answering(200, null));
    await expect(readFinishedTasks(handle, ['t1'])).resolves.toBeNull();
  });

  it('answers null when the daemon cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    );

    await expect(readFinishedTasks(handle, ['t1'])).resolves.toBeNull();
  });
});
