import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import type { ChatService } from '../../agents/services/chat.service';
import type { StartWorkflowChatInput, Workflow } from '../graphs.types';
import { WorkflowChatService } from './workflow-chat.service';
import { WorkflowStoreService } from './workflow-store.service';

const WF: Workflow = {
  name: 'Dev Team',
  nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }],
  edges: [],
};

const CHIPS: StartWorkflowChatInput = {
  agentKind: 'claude',
  model: 'opus',
  approval: 'acceptEdits',
};

function runWire(id: string): RunWire {
  return { id } as RunWire;
}

describe('WorkflowChatService', () => {
  let dir: string;
  let store: WorkflowStoreService;
  let chats: {
    findWorkflowChat: ReturnType<typeof vi.fn>;
    createChat: ReturnType<typeof vi.fn>;
    deleteWorkflowChats: ReturnType<typeof vi.fn>;
  };
  let service: WorkflowChatService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'geniro-workflow-chat-'));
    store = new WorkflowStoreService({ workflowsDir: dir });
    chats = {
      findWorkflowChat: vi.fn().mockResolvedValue(null),
      createChat: vi.fn().mockResolvedValue(runWire('new-run')),
      deleteWorkflowChats: vi.fn().mockResolvedValue({ deleted: 2 }),
    };
    service = new WorkflowChatService(store, chats as unknown as ChatService);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('opens the chat in the library directory, pointed at the workflow file', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.cwd).toBe(dir);
    expect(input.editsWorkflowSlug).toBe(slug);
    expect(input.workflowInstructions).toContain(
      join(dir, `${slug}.geniro.yaml`),
    );
  });

  it('carries the composer chips through to the chat', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.agentKind).toBe('claude');
    expect(input.model).toBe('opus');
    expect(input.approval).toBe('acceptEdits');
  });

  it('titles the thread after the workflow, so it is findable in the sidebar', async () => {
    const { slug } = await store.create(WF);

    await service.open(slug, CHIPS);

    const [input] = chats.createChat.mock.calls[0] as [
      Parameters<ChatService['createChat']>[0],
    ];
    expect(input.title).toBe('Workflow: Dev Team');
  });

  // The panel is somewhere the user comes back to, so a second press must find
  // yesterday's conversation rather than strand it behind a fresh one.
  it('returns the existing chat and creates nothing when one is already open', async () => {
    const { slug } = await store.create(WF);
    chats.findWorkflowChat.mockResolvedValue(runWire('existing-run'));

    await expect(service.open(slug, CHIPS)).resolves.toEqual(
      runWire('existing-run'),
    );
    expect(chats.createChat).not.toHaveBeenCalled();
  });

  it('refuses a slug the library does not hold, without opening a chat', async () => {
    await expect(service.open('no-such-workflow', CHIPS)).rejects.toThrow(
      NotFoundException,
    );
    expect(chats.createChat).not.toHaveBeenCalled();
  });

  it('discards every chat about one workflow without reading the library', async () => {
    await expect(service.discard('already-deleted')).resolves.toEqual({
      deleted: 2,
    });
    expect(chats.deleteWorkflowChats).toHaveBeenCalledWith('already-deleted');
  });

  it('deletes a workflow and the chat about it', async () => {
    const { slug } = await store.create(WF);

    await service.deleteWorkflow(slug);

    await expect(store.get(slug)).rejects.toThrow(NotFoundException);
    expect(chats.deleteWorkflowChats).toHaveBeenCalledWith(slug);
  });

  // The file goes first, so a slug the library never held cannot take a
  // conversation with it.
  it('destroys no chat when the workflow was not there to delete', async () => {
    await expect(service.deleteWorkflow('no-such-workflow')).rejects.toThrow(
      NotFoundException,
    );
    expect(chats.deleteWorkflowChats).not.toHaveBeenCalled();
  });
});
