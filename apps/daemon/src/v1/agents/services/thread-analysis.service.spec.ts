import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '../../runs/entity/run.entity';
import type { RunWire } from '../chat.types';
import { HOST_WORKFLOW_CHANGE_TOOL } from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
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

  function build(source: Partial<Run> | null, maxSeq = 41) {
    const createChat = vi.fn(
      (input: Parameters<ChatService['createChat']>[0]) =>
        Promise.resolve({ id: 'analysis', title: input.title } as RunWire),
    );
    const sendMessage = vi.fn((): Promise<unknown> => Promise.resolve({}));
    const remove = vi.fn(() => Promise.resolve({ deleted: true }));
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
    const runDao = { getById: vi.fn(() => Promise.resolve(sourceRow())) };
    const itemDao = { maxSeq: vi.fn(() => Promise.resolve(maxSeq)) };
    const service = new ThreadAnalysisService(
      { fork: () => ({}) } as unknown as EntityManager,
      runDao as unknown as RunDao,
      itemDao as unknown as ItemDao,
      { createChat, sendMessage, delete: remove } as unknown as ChatService,
    );
    return { service, createChat, sendMessage, remove, runDao, itemDao };
  }

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

  it('records whether the source was still working at the snapshot', async () => {
    const { service, createChat } = build({ status: 'running' });

    await service.start('source', { agentKind: 'claude' });

    expect(createChat.mock.calls[0]![0].analysisSource).toEqual({
      runId: 'source',
      seq: 41,
      working: true,
    });
  });

  it('gives a plain chat the repo-only guide, with the focus appended', async () => {
    const { service, createChat } = build({});

    await service.start('source', {
      agentKind: 'codex',
      focus: 'why so many re-reads?',
    });

    const guide = createChat.mock.calls[0]![0].taskInstructions!;
    expect(guide).toContain('repository changes only');
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
