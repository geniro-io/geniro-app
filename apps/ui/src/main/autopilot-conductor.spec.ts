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
  /**
   * `folder` is what the real route always sends — the card's own resolved
   * against its project's — so the stand-in fills one rather than letting a
   * test omit the field the conductor cuts every worktree from.
   */
  eligible?: {
    id: string;
    title: string;
    status: string;
    folder?: string;
  }[];
}

/** The folder the stand-in daemon resolves a card to unless a test says. */
const QUEUE_FOLDER = '/repo';

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
          ...queue,
          eligible: (queue.eligible ?? []).map((task) => ({
            folder: QUEUE_FOLDER,
            ...task,
          })),
        }),
      } as Response;
    },
  );
  return { fetchMock, starts, refuse };
}

function deps(over: Partial<ConductorDeps> = {}): ConductorDeps {
  return {
    handle: () => handle,
    armedProjects: async () => [{ id: 'p1' }],
    prepareWorktree: vi.fn(async ({ taskId }: { taskId: string }) => ({
      path: `/wt/${taskId}`,
      branch: `geniro/${taskId}`,
      reused: false,
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

  // Any mode that can ASK parks forever: no approval expires, and a turn's
  // silence deadline is suspended while it waits on a verdict. That included
  // `acceptEdits`, which this used to send — it auto-accepts EDITS and routes
  // every Bash call to the approval seam, so an unattended run stopped at the
  // first command it wanted to run.
  it('forces auto-approval and names itself as the starter', async () => {
    const { fetchMock, starts } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    await new AutopilotConductor(deps()).tick();

    expect(starts[0]?.body).toMatchObject({
      approval: 'auto',
      startedBy: 'autopilot',
      from: 'todo',
      cwd: '/wt/t1',
      branch: 'geniro/t1',
    });
  });

  // A card may name a checkout of its own, and the project's folder is only
  // its default — resolved by the daemon, which holds both rows. The conductor
  // used to read the PROJECT's, which is the same answer right up until a task
  // names one, and then runs every autopilot start in the wrong repository.
  it('cuts the worktree from the folder the HANDOUT names', async () => {
    const { fetchMock } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [
          { id: 't1', title: 'elsewhere', status: 'todo', folder: '/other' },
        ],
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    const prepareWorktree = vi.fn(async () => ({
      path: '/wt/t1',
      branch: 'geniro/t1',
      reused: false,
    }));

    await new AutopilotConductor(deps({ prepareWorktree })).tick();

    expect(prepareWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/other',
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

  // Unless it was the task's OWN, already standing: a refusal may then mean
  // the run that made it is still working in it, and giving it back would take
  // that run's cwd away.
  it('keeps a worktree it did not make when the daemon refuses the start', async () => {
    const { fetchMock, refuse } = daemon({
      p1: {
        projectId: 'p1',
        eligible: [{ id: 't1', title: 'x', status: 'todo' }],
      },
    });
    refuse.add('/v1/tasks/t1/runs');
    vi.stubGlobal('fetch', fetchMock);
    const discardWorktree = vi.fn(async () => true);
    const prepareWorktree = vi.fn(async () => ({
      path: '/wt/t1',
      branch: 'geniro/t1',
      reused: true,
    }));

    await new AutopilotConductor(
      deps({ discardWorktree, prepareWorktree }),
    ).tick();

    expect(discardWorktree).not.toHaveBeenCalled();
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
        armedProjects: async () => [{ id: 'missing' }, { id: 'p2' }],
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
              resolve([{ id: 'p1' }]);
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

  // A refusal mocked as `{ ok: false, status }` with no `text()` makes
  // `describeFailure`'s `res.text()` throw before `detailOf` is reached, so
  // these cases supply a real body. This is the daemon's own debug JSONL, and
  // the reader exists so a refused autopilot start names its CAUSE instead of
  // repeating a bare status code for hours.
  describe('reading what a refused start actually said', () => {
    const eligible = [{ id: 't1', title: 'Feedback', status: 'todo' }];

    /** A stand-in daemon whose task-start route answers with a REAL body. */
    function daemonRefusingWithBody(
      status: number,
      body: string,
    ): ReturnType<typeof vi.fn> {
      return vi.fn(
        async (_url: string | URL, init?: RequestInit): Promise<Response> => {
          if (init?.method === 'POST') {
            return { ok: false, status, text: async () => body } as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              enabled: true,
              breakerOpen: false,
              eligible: eligible.map((task) => ({
                folder: QUEUE_FOLDER,
                ...task,
              })),
            }),
          } as Response;
        },
      );
    }

    it('names the daemon’s error code and sentence for a JSON refusal', async () => {
      const fetchMock = daemonRefusingWithBody(
        400,
        JSON.stringify({
          errorCode: 'TASK_RUN_NO_AGENT',
          description: 'this project has no agent configured to run it',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const log = vi.fn();

      await new AutopilotConductor(deps({ log })).tick();

      expect(log).toHaveBeenCalledWith(
        'autopilot did not start "Feedback": POST /v1/tasks/t1/runs answered ' +
          '400: TASK_RUN_NO_AGENT — this project has no agent configured to run it',
      );
    });

    it('falls back to the raw body when it does not parse as JSON', async () => {
      const fetchMock = daemonRefusingWithBody(500, 'upstream timed out');
      vi.stubGlobal('fetch', fetchMock);
      const log = vi.fn();

      await new AutopilotConductor(deps({ log })).tick();

      expect(log).toHaveBeenCalledWith(
        'autopilot did not start "Feedback": POST /v1/tasks/t1/runs answered ' +
          '500: upstream timed out',
      );
    });

    it('truncates a body past the cap rather than logging it whole', async () => {
      // Mirrors `MAX_DETAIL_CHARS` in autopilot-conductor.ts (300) — that
      // constant is not exported, so the cap is pinned here by its effect.
      const longBody = 'x'.repeat(400);
      const fetchMock = daemonRefusingWithBody(500, longBody);
      vi.stubGlobal('fetch', fetchMock);
      const log = vi.fn();

      await new AutopilotConductor(deps({ log })).tick();

      const truncated = `${'x'.repeat(300)}…`;
      expect(log).toHaveBeenCalledWith(
        `autopilot did not start "Feedback": POST /v1/tasks/t1/runs answered 500: ${truncated}`,
      );
      const [line] = log.mock.calls[0] as [string];
      expect(line).not.toContain(longBody);
    });
  });
});
