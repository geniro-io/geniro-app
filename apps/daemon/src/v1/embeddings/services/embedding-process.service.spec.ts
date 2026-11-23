import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { Subscription } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { tempDir } from '../../agents/__tests__/temp-dir';
import {
  configureChildJournal,
  readChildJournal,
  resetChildJournal,
} from '../../agents/utils/child-journal';
import {
  type EmbeddingProcessEvent,
  EmbeddingProcessService,
  EmbeddingUnavailableError,
} from './embedding-process.service';

const FAKE_WORKER = join(
  __dirname,
  '..',
  '__tests__',
  'fake-embedding-worker.js',
);
const RESTART_WAIT_MS = 1_100;
const ANSWER_MS = 5_000;
const MODEL_A = { id: 'model-a', revision: 'rev-a', dir: '/a', dim: 768 };
const MODEL_B = { id: 'model-b', revision: 'rev-b', dir: '/b', dim: 768 };

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupOf(pid: number): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)])
    .toString()
    .trim();
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function crash(service: EmbeddingProcessService): Promise<void> {
  await service
    .request({ op: 'getMeta', key: 'crash' }, 60_000)
    .catch(() => undefined);
}

describe('EmbeddingProcessService', () => {
  let dir: string;
  let services: EmbeddingProcessService[];
  let events: EmbeddingProcessEvent[];
  let subscriptions: Subscription[];

  beforeEach(() => {
    dir = tempDir('embedding-process-');
    services = [];
    events = [];
    subscriptions = [];
  });

  afterEach(async () => {
    for (const service of services) {
      const pid = service.pid;
      service.closeAll();
      if (pid !== null) {
        await vi.waitFor(() => expect(isRunning(pid)).toBe(false), {
          timeout: 5_000,
        });
      }
    }
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
  });

  function start(
    options: { idleUnloadMs?: number } = {},
  ): EmbeddingProcessService {
    const service = new EmbeddingProcessService({
      command: process.execPath,
      args: [FAKE_WORKER],
      dbPath: join(dir, 'embeddings.db'),
      ...options,
    });
    subscriptions.push(
      service.changes().subscribe((event) => events.push(event)),
    );
    services.push(service);
    return service;
  }

  it("answers a request with the worker's result", async () => {
    const service = start();

    expect(
      await service.request({ op: 'getMeta', key: 'hello' }, ANSWER_MS),
    ).toBe('hello');
    expect(events).toContainEqual({ kind: 'started' });
  });

  it('starts the child detached, with ELECTRON_RUN_AS_NODE set in its environment', async () => {
    const service = start();

    expect(
      await service.request({ op: 'getMeta', key: 'env' }, ANSWER_MS),
    ).toBe('1');
    const pid = service.pid ?? Number.NaN;
    expect(processGroupOf(pid)).toBe(String(pid));
  });

  it('sends the models it was given when the child starts, and again when they change', async () => {
    const service = start();
    await service.setModels(MODEL_A, MODEL_B);

    expect(
      await service.request({ op: 'getMeta', key: 'models' }, ANSWER_MS),
    ).toBe(JSON.stringify({ active: MODEL_A, pending: MODEL_B }));

    await service.setModels(null, null);

    expect(
      await service.request({ op: 'getMeta', key: 'models' }, ANSWER_MS),
    ).toBe(JSON.stringify({ active: null, pending: null }));
  });

  it('rejects a request that outlives its timeout, and the child keeps running', async () => {
    const service = start();

    await expect(
      service.request({ op: 'getMeta', key: 'slow' }, 100),
    ).rejects.toThrow('getMeta took longer than 100 ms');
    expect(service.alive).toBe(true);
    expect(
      await service.request({ op: 'getMeta', key: 'after' }, ANSWER_MS),
    ).toBe('after');
  });

  it('rejects the requests in flight when the child crashes, and emits crashed', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);

    const inFlight = service.request({ op: 'getMeta', key: 'slow' }, 60_000);
    const crash = service.request({ op: 'getMeta', key: 'crash' }, 60_000);
    const [slow, crashed] = await Promise.allSettled([inFlight, crash]);

    expect(slow).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'the embedding process exited with code 3',
      }),
    });
    expect(crashed.status).toBe('rejected');
    expect(events).toContainEqual({
      kind: 'crashed',
      reason: 'the embedding process exited with code 3',
      restartInMs: 1_000,
    });
    expect(service.alive).toBe(false);
  });

  it('refuses a request within a second of a crash, then starts the child again', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    const crashedPid = String(service.pid);
    await service
      .request({ op: 'getMeta', key: 'crash' }, 60_000)
      .catch(() => undefined);

    await expect(
      service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    expect(service.failure).toBe('the embedding process exited with code 3');

    await new Promise((resolve) => setTimeout(resolve, RESTART_WAIT_MS));

    const restarted = await service.request(
      { op: 'getMeta', key: 'pid' },
      ANSWER_MS,
    );
    expect(restarted).not.toBe(crashedPid);
  });

  it('forgiveFailures lifts the wait a crash set, so the next request starts the child at once', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    await service
      .request({ op: 'getMeta', key: 'crash' }, 60_000)
      .catch(() => undefined);
    await expect(
      service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);

    service.forgiveFailures();

    expect(
      await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).toBe('echo');
    expect(service.failure).toBeNull();
  });

  it('treats a SIGKILL of the child as a crash for the requests it was answering', async () => {
    const service = start();
    const pid = Number(
      await service.request({ op: 'getMeta', key: 'pid' }, ANSWER_MS),
    );

    const pending = service.request({ op: 'getMeta', key: 'slow' }, 60_000);
    process.kill(pid, 'SIGKILL');

    await expect(pending).rejects.toThrow(
      'the embedding process exited with SIGKILL',
    );
    expect(events).toContainEqual(expect.objectContaining({ kind: 'crashed' }));
  });

  it('stops the child once it has been idle for idleUnloadMs', async () => {
    const service = start({ idleUnloadMs: 200 });
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    const pid = service.pid ?? Number.NaN;

    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'stopped' }), {
      timeout: 3_000,
    });
    expect(service.alive).toBe(false);
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), {
      timeout: 3_000,
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: 'crashed' }),
    );
  });

  it('stop ends the child, and the next request starts a new one', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    const first = service.pid ?? Number.NaN;

    service.stop();
    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'stopped' }), {
      timeout: 3_000,
    });
    await vi.waitFor(() => expect(isRunning(first)).toBe(false), {
      timeout: 3_000,
    });

    expect(
      await service.request({ op: 'getMeta', key: 'pid' }, ANSWER_MS),
    ).not.toBe(String(first));
  });

  it('closeAll ends the child and refuses every later request', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    const pid = service.pid ?? Number.NaN;

    service.closeAll();

    await vi.waitFor(() => expect(events).toContainEqual({ kind: 'stopped' }), {
      timeout: 3_000,
    });
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false), {
      timeout: 3_000,
    });
    await expect(
      service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).rejects.toThrow('the daemon is shutting down');
  });

  it('waits 5 s after a second crash of a child that did no work, where the first waited 1 s', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    await crash(service);
    await pause(RESTART_WAIT_MS);
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    await crash(service);

    await pause(RESTART_WAIT_MS);
    await expect(
      service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);

    await vi.waitFor(
      async () => {
        expect(
          await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
        ).toBe('echo');
      },
      { timeout: 6_000, interval: 100 },
    );
  }, 20_000);

  it('clears the escalation when a work request is answered, so the next crash waits 1 s again', async () => {
    const service = start();
    await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
    await crash(service);
    await pause(RESTART_WAIT_MS);
    await service.request(
      { op: 'score', source: 'memory', query: 'q', sourceIds: null, limit: 1 },
      ANSWER_MS,
    );
    await crash(service);

    await pause(RESTART_WAIT_MS);
    expect(
      await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS),
    ).toBe('echo');
  }, 20_000);

  it('journals the child while it runs and forgets it once it stops', async () => {
    const journalPath = join(dir, 'children.json');
    configureChildJournal(journalPath);
    try {
      const service = start();
      await service.request({ op: 'getMeta', key: 'echo' }, ANSWER_MS);
      const pid = service.pid ?? Number.NaN;
      expect(
        readChildJournal(journalPath)?.children.map((child) => child.pid),
      ).toEqual([pid]);

      service.stop();

      await vi.waitFor(
        () => {
          expect(readChildJournal(journalPath)?.children ?? []).toEqual([]);
        },
        { timeout: 3_000 },
      );
    } finally {
      resetChildJournal();
    }
  });
});
