import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../shared/contracts';
import { type RunStartDeps, startCardPress } from './task-run-start';

const handle: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'tok',
  version: '0.1.0',
  startedAt: '2026-09-07T12:00:00.000Z',
};

const START_SHA = 'a'.repeat(40);

/** What a read answers: a body, or a status code for a read that fails. */
type Answer = Record<string, unknown> | number;

interface Stand {
  /** What the press's own `GET /v1/tasks/t1` answers. */
  card: Answer;
  /** What a read after a refused start answers; the press's card when absent. */
  cardAfterRefusal?: Answer;
  projectFolder: string | null;
  /** How `POST /v1/tasks/t1/runs` answers. */
  start: { status: number; body?: string };
}

function daemon(stand: Stand) {
  const starts: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const fetchMock = vi.fn(
    async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(url)).pathname;
      if (init?.method === 'POST') {
        starts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return {
          ok: stand.start.status < 400,
          status: stand.start.status,
          text: async () => stand.start.body ?? '',
        } as Response;
      }
      reads.push(path);
      const cardReads = reads.filter((read) => read === '/v1/tasks/t1');
      const answer: Answer =
        path === '/v1/tasks/t1'
          ? cardReads.length > 1
            ? (stand.cardAfterRefusal ?? stand.card)
            : stand.card
          : path === '/v1/projects/p1'
            ? { id: 'p1', folder: stand.projectFolder }
            : 404;
      return typeof answer === 'number'
        ? ({ ok: false, status: answer, text: async () => '' } as Response)
        : ({ ok: true, status: 200, json: async () => answer } as Response);
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { starts, reads };
}

function deps(over: Partial<RunStartDeps> = {}): RunStartDeps {
  return {
    prepareWorktree: vi.fn(async ({ taskId }: { taskId: string }) => ({
      path: `/wt/${taskId}`,
      branch: `geniro/task-${taskId}`,
      reused: false,
    })),
    discardWorktree: vi.fn(async () => true),
    gitStamp: vi.fn(async () => ({ sha: START_SHA, dirty: false })),
    agentOptions: () => ({ claude: { browserTools: true } }),
    customInstructions: () => 'Be brief.',
    replyLanguage: () => 'Russian',
    ...over,
  };
}

const card = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 't1',
  title: 'Ship it',
  projectId: 'p1',
  folder: null,
  status: 'todo',
  ...over,
});

const refusal = (status: number, code: string, message: string) => ({
  status,
  body: JSON.stringify({ statusCode: status, code, message }),
});

describe('startCardPress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cuts the worktree from the project's folder for a card naming none, and starts the run as the user's press", async () => {
    const { starts } = daemon({
      card: card(),
      projectFolder: '/repo',
      start: { status: 201 },
    });
    const d = deps();

    const result = await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo', prompt: '  the tests still fail ' },
      () => undefined,
    );

    expect(result).toEqual({ ok: true });
    expect(d.prepareWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/repo',
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      branch: 'geniro/task-t1',
      from: 'todo',
      startedBy: 'user',
      prompt: 'the tests still fail',
      startSha: START_SHA,
      startDirty: false,
      agentOptions: { claude: { browserTools: true } },
      customInstructions: 'Be brief.',
      replyLanguage: 'Russian',
    });
    expect(starts[0]).not.toHaveProperty('cwd');
    expect(starts[0]).not.toHaveProperty('approval');
  });

  it('cuts from the folder the CARD names, and asks nothing of its project', async () => {
    const { reads } = daemon({
      card: card({ folder: '/elsewhere' }),
      projectFolder: '/repo',
      start: { status: 201 },
    });
    const d = deps();

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.prepareWorktree).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/elsewhere',
    });
    expect(reads).not.toContain('/v1/projects/p1');
  });

  it('sends no prompt when the press said nothing', async () => {
    const { starts } = daemon({
      card: card(),
      projectFolder: '/repo',
      start: { status: 201 },
    });

    await startCardPress(
      deps(),
      handle,
      { taskId: 't1', from: 'todo', prompt: '   ' },
      () => undefined,
    );

    expect(starts[0]).not.toHaveProperty('prompt');
  });

  it("answers git's line and starts nothing when the worktree cannot be made", async () => {
    const { starts } = daemon({
      card: card(),
      projectFolder: '/repo',
      start: { status: 201 },
    });

    const result = await startCardPress(
      deps({
        prepareWorktree: vi.fn(async () => {
          throw new Error('fatal: not a git repository');
        }),
      }),
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(result).toEqual({ ok: false, error: 'fatal: not a git repository' });
    expect(starts).toHaveLength(0);
  });

  it("answers the daemon's own sentence and gives back the worktree it made when nothing else holds the card", async () => {
    daemon({
      card: card(),
      projectFolder: '/repo',
      start: refusal(400, 'NO_RUN_TARGET', 'no agent or team for this card'),
    });
    const d = deps();

    const result = await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(result).toEqual({
      ok: false,
      error: 'no agent or team for this card',
    });
    expect(d.discardWorktree).toHaveBeenCalledWith('t1');
  });

  it('keeps the worktree when the refusal names another start of the card', async () => {
    daemon({
      card: card(),
      projectFolder: '/repo',
      start: refusal(
        409,
        'TASK_RUN_STARTING',
        'task t1 is already starting a run',
      ),
    });
    const d = deps();

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  it("leaves the task's OWN worktree alone when the start is refused", async () => {
    daemon({
      card: card(),
      projectFolder: '/repo',
      start: refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 moved'),
    });
    const d = deps({
      prepareWorktree: vi.fn(async () => ({
        path: '/wt/t1',
        branch: 'geniro/task-t1',
        reused: true,
      })),
    });

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  it('answers a card the daemon no longer has, and makes no worktree', async () => {
    daemon({ card: 404, projectFolder: '/repo', start: { status: 201 } });
    const d = deps();

    const result = await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(result).toEqual({
      ok: false,
      error: 'GET /v1/tasks/t1 answered 404',
    });
    expect(d.prepareWorktree).not.toHaveBeenCalled();
  });

  it('answers a card that names no project, and makes no worktree', async () => {
    daemon({
      card: { id: 't1' },
      projectFolder: '/repo',
      start: { status: 201 },
    });
    const d = deps();

    const result = await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(result).toEqual({
      ok: false,
      error: 'the card t1 names no project',
    });
    expect(d.prepareWorktree).not.toHaveBeenCalled();
  });

  it('answers a card with no folder of its own in a project with none, and makes no worktree', async () => {
    daemon({ card: card(), projectFolder: null, start: { status: 201 } });
    const d = deps();

    const result = await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(result).toEqual({
      ok: false,
      error: 'the card t1 has no folder to work in',
    });
    expect(d.prepareWorktree).not.toHaveBeenCalled();
  });

  it('gives back the worktree it made when the card is gone after the refusal', async () => {
    daemon({
      card: card(),
      cardAfterRefusal: 404,
      projectFolder: '/repo',
      start: refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 moved'),
    });
    const d = deps();

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.discardWorktree).toHaveBeenCalledWith('t1');
  });

  it('keeps the worktree when the card is being worked after the refusal', async () => {
    daemon({
      card: card(),
      cardAfterRefusal: card({ status: 'in_progress' }),
      projectFolder: '/repo',
      start: refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 is in in_progress'),
    });
    const d = deps();

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  it('keeps the worktree when the card cannot be read after the refusal', async () => {
    daemon({
      card: card(),
      cardAfterRefusal: 500,
      projectFolder: '/repo',
      start: refusal(400, 'TASK_STATUS_CONFLICT', 'task t1 moved'),
    });
    const d = deps();

    await startCardPress(
      d,
      handle,
      { taskId: 't1', from: 'todo' },
      () => undefined,
    );

    expect(d.discardWorktree).not.toHaveBeenCalled();
  });

  it('logs a worktree it could not give back, and still answers the refusal', async () => {
    daemon({
      card: card(),
      projectFolder: '/repo',
      start: refusal(400, 'NO_RUN_TARGET', 'no agent or team for this card'),
    });
    const log = vi.fn();

    const result = await startCardPress(
      deps({
        discardWorktree: vi.fn(async () => {
          throw new Error('EBUSY');
        }),
      }),
      handle,
      { taskId: 't1', from: 'todo' },
      log,
    );

    expect(result).toEqual({
      ok: false,
      error: 'no agent or team for this card',
    });
    expect(log).toHaveBeenCalledWith(
      'could not release the worktree for "Ship it": EBUSY',
    );
  });
});
