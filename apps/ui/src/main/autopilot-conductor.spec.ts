import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { AutopilotConductor, type ConductorDeps } from './autopilot-conductor';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
};

interface QueueBody {
  projectId: string;
  enabled?: boolean;
  breakerOpen?: boolean;
  eligible?: { id: string; title: string; status: string }[];
}

/**
 * A stand-in daemon, answering the two routes a tick uses.
 *
 * It records every start so the tests can assert on what the conductor
 * actually asked for — the approval mode it forces and the starter it names
 * are the whole of what makes an autopilot run different from a person's.
 */
function daemon(queues: Record<string, QueueBody>) {
  const starts: { path: string; body: Record<string, unknown> }[] = [];
  const refuse = new Set<string>();
  const fetchMock = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (refuse.has(path)) {
          return { ok: false, status: 409 } as Response;
        }
        starts.push({ path, body });
        return { ok: true, status: 201 } as Response;
      }
      const id = /\/v1\/projects\/([^/]+)\/queue/.exec(path)?.[1] ?? '';
      const queue = queues[id];
      if (!queue) {
        return { ok: false, status: 404 } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          enabled: true,
          breakerOpen: false,
          eligible: [],
          ...queue,
        }),
      } as Response;
    },
  );
  return { fetchMock, starts, refuse };
}

function deps(over: Partial<ConductorDeps> = {}): ConductorDeps {
  return {
    handle: () => handle,
    armedProjects: async () => [{ id: 'p1', folder: '/repo' }],
    prepareWorktree: vi.fn(async ({ taskId }: { taskId: string }) => ({
      path: `/wt/${taskId}`,
      branch: `geniro/${taskId}`,
    })),
    discardWorktree: vi.fn(async () => true),
    log: () => undefined,
    intervalMs: 5,
    ...over,
  };
}

describe('AutopilotConductor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts exactly what the daemon handed out, in order', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [
          { id: 't1', title: 'first', status: 'todo' },
          { id: 't2', title: 'second', status: 'todo' },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts.map((start) => start.path)).toEqual([
      '/v1/tasks/t1/runs',
      '/v1/tasks/t2/runs',
    ]);
  });

  // The cap lives in the daemon. This pins that the conductor does not
  // second-guess it in either direction — it starts the handout and no more,
  // which is what makes two windows safe.
  it('starts only the handout, however much is waiting behind it', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'only one', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts).toHaveLength(1);
  });

  // `ask` would park forever: no approval expires, and a turn's silence
  // deadline is suspended while it waits on a verdict.
  it('forces acceptEdits and names itself as the starter', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts[0]?.body).toMatchObject({
      approval: 'acceptEdits',
      startedBy: 'autopilot',
      from: 'todo',
      cwd: '/wt/t1',
      branch: 'geniro/t1',
    });
  });

  it('starts nothing while the breaker is open', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        breakerOpen: true,
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts).toEqual([]);
  });

  it('starts nothing for a project that has been disarmed', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        enabled: false,
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts).toEqual([]);
  });

  // A refusal is the ordinary case — another window got there first — so the
  // worktree has to go back, or every lost race leaves a checkout on disk for
  // a run that never began.
  it('gives the worktree back when the daemon refuses the start', async () => {
    const { fetchMock, refuse } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    refuse.add('/v1/tasks/t1/runs');
    vi.stubGlobal('fetch', fetchMock);
    const discardWorktree = vi.fn(async () => true);

    await new AutopilotConductor(deps({ discardWorktree })).tick();

    expect(discardWorktree).toHaveBeenCalledWith('t1');
  });

  it('does not start a task whose worktree could not be made', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const prepareWorktree = vi.fn(async () => {
      throw new Error('uncommitted changes');
    });

    await new AutopilotConductor(deps({ prepareWorktree })).tick();

    expect(starts).toEqual([]);
  });

  // Nobody is watching a timer, so one bad project must not end the sweep.
  it('sweeps the remaining projects after one fails', async () => {
    const { fetchMock, starts } = daemon({
      p2: {
        projectId: 'p2',
        eligible: [{ id: 't9', title: 'later', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(
      deps({
        armedProjects: async () => [
          { id: 'missing', folder: '/a' },
          { id: 'p2', folder: '/b' },
        ],
      }),
    ).tick();

    expect(starts.map((start) => start.path)).toEqual(['/v1/tasks/t9/runs']);
  });

  it('does nothing at all while no daemon is running', async () => {
    const { fetchMock } = daemon({ p1: { projectId: 'p1' } });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps({ handle: () => null })).tick();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ticks on its own timer once started, and stops on stop()', async () => {
    const { fetchMock } = daemon({ p1: { projectId: 'p1' } });
    vi.stubGlobal('fetch', fetchMock);
    const conductor = new AutopilotConductor(deps({ intervalMs: 5 }));

    conductor.start();
    await vi.advanceTimersByTimeAsync(12);
    const ticked = fetchMock.mock.calls.length;
    expect(ticked).toBeGreaterThan(0);

    conductor.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(fetchMock.mock.calls.length).toBe(ticked);
  });

  // A slow tick overlapping the next one would read the same queue twice and
  // start the same card twice — refused daemon-side, but each refusal costs a
  // worktree made and given back.
  it('does not let one tick overlap the next', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    let release: (() => void) | undefined;
    const conductor = new AutopilotConductor(
      deps({
        armedProjects: () =>
          new Promise((resolve) => {
            release = () => {
              resolve([{ id: 'p1', folder: '/repo' }]);
            };
          }),
      }),
    );

    const first = conductor.tick();
    await conductor.tick();
    release?.();
    await first;

    expect(starts).toHaveLength(1);
  });
});
