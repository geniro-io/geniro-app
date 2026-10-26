import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import type { RunWire } from '../chat.types';
import { HOST_WORKFLOW_CHANGE_TOOL } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import type { AgentEventBus } from './agent-events.bus';
import type { ChatService } from './chat.service';
import { ThreadAnalysisService } from './thread-analysis.service';

describe('ThreadAnalysisService.start', () => {
  let folder: string;

  beforeEach(() => {
    // Canonical, as the service stores it (`/var` is `/private/var` on macOS).
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'analysis-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  function build(
    source: Partial<Run> | null,
    maxSeq = 41,
    earlier: string[] = [],
  ) {
    // What the thread holds besides `earlier`: the new chat once created, and
    // whatever a racing start made meanwhile.
    const listed: string[] = [];
    const createChat = vi.fn(
      (input: Parameters<ChatService['createChat']>[0]) => {
        listed.unshift('analysis');
        return Promise.resolve({
          id: 'analysis',
          title: input.title,
          status: 'pending',
        } as RunWire);
      },
    );
    const sendMessage = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const remove = vi.fn(() => Promise.resolve({ deleted: true }));
    // The row as it reads after the brief went out — what the popup opens on.
    const findAnalysis = vi.fn(() =>
      Promise.resolve({ id: 'analysis', status: 'running' } as RunWire),
    );
    const deleted = new Subject<string>();
    const sourceRow = (): Run | null =>
      source === null
        ? null
        : ({
            id: 'source',
            title: 'Dev Team run',
            workflowId: null,
            cwd: folder,
            archivedAt: null,
            status: 'completed',
            analysisSourceRunId: null,
            ...source,
          } as Run);
    const runDao = {
      getById: vi.fn(() => Promise.resolve(sourceRow())),
      // Newest first, as the DAO answers.
      listAnalysesOf: vi.fn(() =>
        Promise.resolve([...listed, ...earlier].map((id) => ({ id }) as Run)),
      ),
      listOrphanedAnalyses: vi.fn(() => Promise.resolve([] as Run[])),
    };
    const itemDao = { maxSeq: vi.fn(() => Promise.resolve(maxSeq)) };
    const service = new ThreadAnalysisService(
      { fork: () => ({}) } as unknown as EntityManager,
      runDao as unknown as RunDao,
      itemDao as unknown as ItemDao,
      {
        createChat,
        sendMessage,
        delete: remove,
        findAnalysis,
      } as unknown as ChatService,
      { allDeleted: () => deleted.asObservable() } as unknown as AgentEventBus,
    );
    return {
      service,
      listed,
      createChat,
      sendMessage,
      remove,
      findAnalysis,
      runDao,
      itemDao,
      deleted,
    };
  }

  it('replaces the thread’s earlier analysis once the new one has its brief', async () => {
    const { service, sendMessage, remove, findAnalysis } = build({}, 41, [
      'old-analysis',
    ]);

    const started = await service.start('source', { agentKind: 'claude' });

    expect(remove).toHaveBeenCalledWith('old-analysis');
    expect(remove).not.toHaveBeenCalledWith('analysis');
    // Only after the new one is under way: a start that fails keeps the old.
    expect(remove.mock.invocationCallOrder[0]).toBeGreaterThan(
      sendMessage.mock.invocationCallOrder[0]!,
    );
    // And it answers with its own row as it reads now, not the pre-brief copy.
    expect(started.status).toBe('running');
    expect(findAnalysis).toHaveBeenCalledWith('source', 'analysis');
  });

  it('deletes only what it replaces, so a start racing it keeps its own analysis', async () => {
    const { service, sendMessage, remove, listed } = build({}, 41, ['old']);
    // A second window's start lands while this one's brief goes out.
    sendMessage.mockImplementationOnce(() => {
      listed.unshift('racing');
      return Promise.resolve({});
    });

    await service.start('source', { agentKind: 'claude' });

    expect(remove.mock.calls).toEqual([['old']]);
  });

  it('sweeps at boot the analyses whose thread is already gone, and survives a failed sweep', async () => {
    const { service, runDao, remove } = build({});
    runDao.listOrphanedAnalyses.mockResolvedValueOnce([
      { id: 'orphan-1' },
      { id: 'orphan-2' },
    ] as Run[]);

    service.onApplicationBootstrap();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove.mock.calls).toEqual([['orphan-1'], ['orphan-2']]);

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runDao.listOrphanedAnalyses.mockRejectedValueOnce(new Error('db closed'));
    service.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('keeps the earlier analysis when the new one cannot be started', async () => {
    const { service, sendMessage, remove } = build({}, 41, ['old-analysis']);
    sendMessage.mockRejectedValueOnce(new Error('RUN_NOT_CONFIGURED'));

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toThrow('RUN_NOT_CONFIGURED');
    expect(remove).not.toHaveBeenCalledWith('old-analysis');
  });

  it('deletes a thread’s analysis when the thread itself is deleted', async () => {
    const { service, runDao, remove, deleted } = build({}, 41, [
      'newer',
      'old',
    ]);
    service.onModuleInit();

    deleted.next('source');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));

    expect(runDao.listAnalysesOf).toHaveBeenCalledWith(
      'source',
      expect.anything(),
    );
    expect(remove).toHaveBeenCalledWith('newer');
    expect(remove).toHaveBeenCalledWith('old');
    service.onModuleDestroy();
  });

  it('goes on deleting the rest when one analysis cannot be deleted, and survives a failed lookup', async () => {
    const { service, runDao, remove, deleted } = build({}, 41, [
      'newer',
      'old',
    ]);
    remove.mockRejectedValueOnce(new Error('disk gone'));
    service.onModuleInit();

    deleted.next('source');
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(remove).toHaveBeenLastCalledWith('old');

    // A lookup that fails is logged, never an unhandled rejection.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    runDao.listAnalysesOf.mockRejectedValueOnce(new Error('db closed'));
    deleted.next('source');
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('finds the thread’s analysis, refusing a thread that does not exist', async () => {
    const { service, findAnalysis } = build({});

    await expect(service.find('source')).resolves.toMatchObject({
      id: 'analysis',
    });
    expect(findAnalysis).toHaveBeenCalledWith('source');
    await expect(build(null).service.find('source')).rejects.toMatchObject({
      errorCode: 'RUN_NOT_FOUND',
    });
  });

  it('starts a linked chat with the workflow guide for a workflow source', async () => {
    const { service, createChat, sendMessage } = build({
      workflowId: 'dev-team',
    });

    await service.start('source', { agentKind: 'claude', model: 'opus' });

    const input = createChat.mock.calls[0]![0];
    expect(input).toMatchObject({
      agentKind: 'claude',
      model: 'opus',
      cwd: folder,
      title: 'Analysis: Dev Team run',
      analysisSource: { runId: 'source', seq: 41, working: false },
    });
    expect(input.taskInstructions).toContain('This is a WORKFLOW thread');
    expect(input.taskInstructions).toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(sendMessage).toHaveBeenCalledWith(
      'analysis',
      expect.stringContaining('a workflow thread'),
    );
  });

  it('hands the analysis chat the user’s reply language', async () => {
    const { service, createChat } = build({ workflowId: 'dev-team' });

    await service.start('source', {
      agentKind: 'claude',
      replyLanguage: 'Russian',
    });

    expect(createChat.mock.calls[0]![0].replyLanguage).toBe('Russian');
  });

  it('starts the analysis on auto-approve unless the dialog names a mode', async () => {
    const { service, createChat } = build({});

    await service.start('source', { agentKind: 'claude' });
    await service.start('source', { agentKind: 'claude', approval: 'ask' });

    // Never the chat default `ask`: omitted means `auto`.
    expect(createChat.mock.calls[0]![0].approval).toBe('auto');
    expect(createChat.mock.calls[1]![0].approval).toBe('ask');
  });

  it('records whether the source was still working at the snapshot', async () => {
    const { service, createChat } = build({ status: 'running' });

    await service.start('source', { agentKind: 'claude' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: true,
    });
  });

  it('gives a plain chat the guide without workflow changes, with the focus appended', async () => {
    const { service, createChat } = build({});

    await service.start('source', {
      agentKind: 'codex',
      focus: 'why so many re-reads?',
    });

    const guide = createChat.mock.calls[0]![0].taskInstructions!;
    expect(guide).toContain('Never recommend a workflow change');
    expect(guide).not.toContain(HOST_WORKFLOW_CHANGE_TOOL);
    expect(guide).toContain('why so many re-reads?');
  });

  it("refuses with ANALYSIS_FOLDER_GONE when the source's folder is gone, and runs in a folder sent instead", async () => {
    const { service, createChat } = build({ cwd: join(folder, 'deleted') });

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_FOLDER_GONE' });
    expect(createChat).not.toHaveBeenCalled();

    await service.start('source', { agentKind: 'claude', cwd: folder });
    expect(createChat.mock.calls[0]![0].cwd).toBe(folder);
  });

  it('re-reads until no row lands between the status and the snapshot', async () => {
    const { service, createChat, runDao, itemDao } = build({});
    const at = (status: string) => ({
      id: 'source',
      title: 'Dev Team run',
      workflowId: null,
      cwd: folder,
      archivedAt: null,
      status,
      analysisSourceRunId: null,
    });
    runDao.getById
      .mockResolvedValueOnce(at('completed') as never)
      .mockResolvedValueOnce(at('completed') as never)
      .mockResolvedValueOnce(at('running') as never);
    itemDao.maxSeq
      .mockResolvedValueOnce(40)
      .mockResolvedValueOnce(41)
      .mockResolvedValue(41);

    await service.start('source', { agentKind: 'claude' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: true,
    });
    // Each status read uses its own fork, so no identity map answers it.
    const forks = runDao.getById.mock.calls.map(
      (call) => (call as unknown[])[1],
    );
    expect(new Set(forks).size).toBe(forks.length);
  });

  it("refuses a folder the user picked with that folder's own reason", async () => {
    const { service, createChat } = build({ cwd: join(folder, 'deleted') });
    const picked = join(folder, 'nope');

    await expect(
      service.start('source', { agentKind: 'claude', cwd: picked }),
    ).rejects.toMatchObject({
      errorCode: 'ANALYSIS_FOLDER_GONE',
      message: expect.stringContaining(picked),
    });
    expect(createChat).not.toHaveBeenCalled();
  });

  it('removes the new chat when its brief cannot be sent, and says why', async () => {
    const { service, sendMessage, remove } = build({});
    sendMessage.mockRejectedValueOnce(new Error('RUN_NOT_CONFIGURED'));

    await expect(
      service.start('source', { agentKind: 'claude' }),
    ).rejects.toThrow('RUN_NOT_CONFIGURED');
    expect(remove).toHaveBeenCalledWith('analysis');
  });

  it('refuses an archived source and an analysis of an analysis', async () => {
    await expect(
      build({ archivedAt: new Date() }).service.start('source', {
        agentKind: 'claude',
      }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_SOURCE_ARCHIVED' });
    await expect(
      build({ analysisSourceRunId: 'other' }).service.start('source', {
        agentKind: 'claude',
      }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_OF_ANALYSIS' });
  });

  it('refuses a source with no rows, and one that does not exist', async () => {
    await expect(
      build({}, -1).service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'ANALYSIS_SOURCE_EMPTY' });
    await expect(
      build(null).service.start('source', { agentKind: 'claude' }),
    ).rejects.toMatchObject({ errorCode: 'RUN_NOT_FOUND' });
  });
});
