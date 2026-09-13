// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPreloadStub } from '../__fixtures__/preload-stub';
import type { DaemonApis } from '../daemon-api';
import {
  isMissingCwdError,
  restoreTaskWorktree,
  sendRestoringWorktree,
} from './task-worktree';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A refusal in the daemon's uniform shape, as `createDaemonApis` throws it. */
const refusal = (status: number, code: string, message: string): Error =>
  new Error(
    `daemon POST /v1/chats/r1/messages failed (${status}): ${JSON.stringify({
      code,
      message,
    })}`,
  );

const missingCwd = (): Error =>
  refusal(400, 'INVALID_CWD', 'cwd does not exist: /userData/worktrees/t1');

function fakeApis(cardFolder: string | null): {
  apis: Pick<DaemonApis, 'tasks' | 'projects'>;
  readTask: ReturnType<typeof vi.fn>;
  readProject: ReturnType<typeof vi.fn>;
} {
  const readTask = vi.fn(async () => ({
    id: 't1',
    projectId: 'p1',
    folder: cardFolder,
  }));
  const readProject = vi.fn(async () => ({ id: 'p1', folder: '/repo' }));
  return {
    apis: {
      tasks: { readTask },
      projects: { readProject },
    } as unknown as Pick<DaemonApis, 'tasks' | 'projects'>,
    readTask,
    readProject,
  };
}

function stubPrepare(ok: boolean): ReturnType<typeof vi.fn> {
  const prepareTaskWorktree = vi.fn(async () => ({
    ok,
    path: ok ? '/userData/worktrees/t1' : null,
    branch: ok ? 'geniro/task-t1' : null,
    reused: false,
    error: ok ? null : 'fatal: not a git repository',
  }));
  window.geniro = createPreloadStub({ prepareTaskWorktree });
  return prepareTaskWorktree;
}

describe('isMissingCwdError', () => {
  it('reads the daemon’s code, not its sentence', () => {
    expect(isMissingCwdError(missingCwd())).toBe(true);
    // A different refusal whose MESSAGE happens to say the same words.
    expect(
      isMissingCwdError(
        refusal(400, 'INVALID_CONFIG_DIR', 'cwd does not exist'),
      ),
    ).toBe(false);
  });
});

describe('sendRestoringWorktree', () => {
  it('puts a task’s worktree back and sends once more when its folder is gone', async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingCwd())
      .mockResolvedValueOnce('sent');
    const restore = vi.fn(async () => true);

    await expect(sendRestoringWorktree(send, 't1', restore)).resolves.toBe(
      'sent',
    );
    expect(restore).toHaveBeenCalledWith('t1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('shows the daemon’s own refusal when the worktree could not be restored', async () => {
    const original = missingCwd();
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(original);

    await expect(
      sendRestoringWorktree(send, 't1', async () => false),
    ).rejects.toBe(original);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never restores anything for a chat that is not a task’s', async () => {
    const original = missingCwd();
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(original);
    const restore = vi.fn(async () => true);

    await expect(sendRestoringWorktree(send, null, restore)).rejects.toBe(
      original,
    );
    expect(restore).not.toHaveBeenCalled();
  });

  it('leaves every other refusal alone', async () => {
    const busy = refusal(409, 'RUN_BUSY', 'a turn is already running');
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(busy);
    const restore = vi.fn(async () => true);

    await expect(sendRestoringWorktree(send, 't1', restore)).rejects.toBe(busy);
    expect(restore).not.toHaveBeenCalled();
  });

  it('sends only ONCE more, and shows a second refusal as it is', async () => {
    const second = missingCwd();
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(missingCwd())
      .mockRejectedValueOnce(second);

    await expect(
      sendRestoringWorktree(send, 't1', async () => true),
    ).rejects.toBe(second);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('restoreTaskWorktree', () => {
  it('cuts it from the card’s own folder when the card names one', async () => {
    const prepare = stubPrepare(true);
    const { apis, readProject } = fakeApis('/elsewhere');

    await expect(restoreTaskWorktree(apis, 't1')).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith({
      taskId: 't1',
      folder: '/elsewhere',
    });
    expect(readProject).not.toHaveBeenCalled();
  });

  it('falls back to the project’s folder, as a Run press does', async () => {
    const prepare = stubPrepare(true);
    const { apis } = fakeApis(null);

    await expect(restoreTaskWorktree(apis, 't1')).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledWith({ taskId: 't1', folder: '/repo' });
  });

  it('answers false when main could not make the worktree', async () => {
    stubPrepare(false);
    const { apis } = fakeApis(null);

    await expect(restoreTaskWorktree(apis, 't1')).resolves.toBe(false);
  });

  it('answers false when the card cannot be read, rather than throwing', async () => {
    const prepare = stubPrepare(true);
    const { apis, readTask } = fakeApis(null);
    readTask.mockRejectedValue(
      new Error('daemon GET /v1/tasks/t1 failed (404)'),
    );

    await expect(restoreTaskWorktree(apis, 't1')).resolves.toBe(false);
    expect(prepare).not.toHaveBeenCalled();
  });
});
