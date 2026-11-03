import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import type { SleepBlocker } from './keep-awake';

vi.mock('electron', () => ({ app: {} }));

const {
  KEEP_AWAKE_MAX_FAILED_READINGS,
  KeepAwake,
  parseAgentActivity,
  readAgentsWorking,
} = await import('./keep-awake');

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok-1',
  version: '0.1.0',
  startedAt: '2026-11-04T00:00:00.000Z',
};
const POLL_MS = 1_000;

function fakeBlocker(): {
  start: Mock<SleepBlocker['start']>;
  stop: Mock<SleepBlocker['stop']>;
  live: Set<number>;
} {
  const live = new Set<number>();
  let next = 0;
  return {
    live,
    start: vi.fn((type: 'prevent-app-suspension') => {
      expect(type).toBe('prevent-app-suspension');
      next += 1;
      live.add(next);
      return next;
    }),
    stop: vi.fn((id: number) => live.delete(id)),
  };
}

function setup(initial: { handle?: DaemonHandle | null } = {}): {
  keepAwake: InstanceType<typeof KeepAwake>;
  blocker: ReturnType<typeof fakeBlocker>;
  answer: { working: boolean | Error };
  handle: { current: DaemonHandle | null };
  reports: string[];
} {
  const blocker = fakeBlocker();
  const answer: { working: boolean | Error } = { working: false };
  const handle = {
    current: initial.handle === undefined ? HANDLE : initial.handle,
  };
  const reports: string[] = [];
  const keepAwake = new KeepAwake({
    blocker,
    report: (message) => reports.push(message),
    getHandle: () => handle.current,
    readWorking: () =>
      answer.working instanceof Error
        ? Promise.reject(answer.working)
        : Promise.resolve(answer.working),
    pollMs: POLL_MS,
  });
  return { keepAwake, blocker, answer, handle, reports };
}

async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(POLL_MS);
}

describe('KeepAwake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds nothing while switched off, however busy the daemon is', async () => {
    const { keepAwake, blocker, answer } = setup();
    answer.working = true;

    await poll();

    expect(keepAwake.holding).toBe(false);
    expect(blocker.start).not.toHaveBeenCalled();
  });

  it('holds while agents work and lets go once they stop', async () => {
    const { keepAwake, blocker, answer } = setup();
    answer.working = true;

    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(keepAwake.holding).toBe(true);
    expect(blocker.live.size).toBe(1);

    await poll();
    expect(blocker.start).toHaveBeenCalledTimes(1);

    answer.working = false;
    await poll();
    expect(keepAwake.holding).toBe(false);
    expect(blocker.live.size).toBe(0);
  });

  it('lets go at once when the setting is turned off mid-hold', async () => {
    const { keepAwake, blocker, answer } = setup();
    answer.working = true;
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    keepAwake.setEnabled(false);

    expect(keepAwake.holding).toBe(false);
    expect(blocker.live.size).toBe(0);
    await poll();
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });

  it('drops a reading that lands after the setting was turned off', async () => {
    const blocker = fakeBlocker();
    let resolve: (working: boolean) => void = () => undefined;
    const keepAwake = new KeepAwake({
      blocker,
      getHandle: () => HANDLE,
      readWorking: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
      pollMs: POLL_MS,
    });

    keepAwake.setEnabled(true);
    keepAwake.setEnabled(false);
    resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(blocker.start).not.toHaveBeenCalled();
  });

  it('lets go when the daemon is gone', async () => {
    const { keepAwake, answer, handle } = setup();
    answer.working = true;
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    handle.current = null;
    await poll();

    expect(keepAwake.holding).toBe(false);
  });

  it('keeps a hold through a few failed readings, then lets go', async () => {
    const { keepAwake, answer } = setup();
    answer.working = true;
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    answer.working = new Error('timeout');
    for (let i = 1; i < KEEP_AWAKE_MAX_FAILED_READINGS; i += 1) {
      await poll();
      expect(keepAwake.holding).toBe(true);
    }
    await poll();
    expect(keepAwake.holding).toBe(false);
  });

  it('counts only failures in a row: a good reading between them starts the count again', async () => {
    const { keepAwake, answer } = setup();
    answer.working = true;
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    const fail = async (times: number): Promise<void> => {
      answer.working = new Error('timeout');
      for (let i = 0; i < times; i += 1) {
        await poll();
      }
    };
    await fail(KEEP_AWAKE_MAX_FAILED_READINGS - 1);
    answer.working = true;
    await poll();
    await fail(KEEP_AWAKE_MAX_FAILED_READINGS - 1);

    expect(keepAwake.holding).toBe(true);
  });

  it('logs the first failure of a streak even while nothing is held, and only the first', async () => {
    const { keepAwake, answer, reports } = setup();
    answer.working = new Error('answered 500');

    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    await poll();

    expect(
      reports.filter((line) => line.includes('answered 500')),
    ).toHaveLength(1);
  });

  it('never starts a hold on a failed reading', async () => {
    const { keepAwake, blocker, answer } = setup();
    answer.working = new Error('refused');

    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(blocker.start).not.toHaveBeenCalled();
  });

  it('reads again at once when a daemon comes up', async () => {
    const { keepAwake, answer, handle } = setup({ handle: null });
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(keepAwake.holding).toBe(false);

    handle.current = HANDLE;
    answer.working = true;
    keepAwake.poke();
    await vi.advanceTimersByTimeAsync(0);

    expect(keepAwake.holding).toBe(true);
  });

  it('lets go on dispose', async () => {
    const { keepAwake, blocker, answer } = setup();
    answer.working = true;
    keepAwake.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);

    keepAwake.dispose();

    expect(blocker.live.size).toBe(0);
    await poll();
    expect(blocker.start).toHaveBeenCalledTimes(1);
  });
});

describe('readAgentsWorking', () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status })),
    ) as unknown as typeof fetch;

  it('asks the activity route with the launch token', async () => {
    const fetchImpl = respond(200, { working: true });

    await expect(readAgentsWorking(HANDLE, fetchImpl)).resolves.toBe(true);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:47615/v1/agents/activity');
    expect(init.headers).toEqual({ authorization: 'Bearer tok-1' });
  });

  it("falls back to the supervisor's busy check on a daemon without the route", async () => {
    const checkBusy = vi.fn(() => Promise.resolve(true));

    await expect(
      readAgentsWorking(HANDLE, respond(404, {}), checkBusy),
    ).resolves.toBe(true);
    expect(checkBusy).toHaveBeenCalledWith(HANDLE);
  });

  it('throws on a refusal and on an unreadable body', async () => {
    await expect(readAgentsWorking(HANDLE, respond(500, {}))).rejects.toThrow(
      'answered 500',
    );
    await expect(
      readAgentsWorking(HANDLE, respond(200, { working: 'yes' })),
    ).rejects.toThrow('unreadable');
  });

  it('reads only a boolean `working`', () => {
    expect(parseAgentActivity({ working: false })).toBe(false);
    expect(parseAgentActivity({ working: 1 })).toBeNull();
    expect(parseAgentActivity(null)).toBeNull();
  });
});
