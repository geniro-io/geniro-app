import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import type { TaskDao } from '../../tasks/dao/task.dao';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { commandCenterDb } from '../__tests__/command-center-db';
import type { CommandCenterService } from './command-center.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterEventsService } from './command-center-events.service';

const MANAGER = 'manager-1';
const SENT_AT = new Date('2026-11-17T10:00:00.000Z');

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

describe('CommandCenterEventsService', () => {
  let db: Db;
  let agents: AgentEventBus;
  let contacts: {
    publishChanged: ReturnType<typeof vi.fn>;
    publishContact: ReturnType<typeof vi.fn>;
  };
  let board: { managerRunId: ReturnType<typeof vi.fn> };
  let inbox: { awaitingRepliesFrom: ReturnType<typeof vi.fn> };
  let service: CommandCenterEventsService;

  beforeEach(async () => {
    db = await commandCenterDb();
    agents = new AgentEventBus();
    contacts = { publishChanged: vi.fn(), publishContact: vi.fn() };
    board = { managerRunId: vi.fn(() => Promise.resolve(MANAGER)) };
    inbox = {
      awaitingRepliesFrom: vi.fn(() => Promise.resolve(new Set(['thread-1']))),
    };
    service = new CommandCenterEventsService(
      db.em,
      agents,
      new TaskEventBus(),
      { getById: vi.fn() } as unknown as TaskDao,
      inbox as unknown as ThreadInboxService,
      board as unknown as CommandCenterService,
      contacts as unknown as CommandCenterEventBus,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await db.orm.close(true);
  });

  it('relays a message between the manager and a thread as a contact that awaits its reply', async () => {
    agents.publishThreadMessageSent({
      messageId: 'm-1',
      fromRunId: MANAGER,
      toRunId: 'thread-1',
      at: SENT_AT,
      expectsReply: true,
    });

    await vi.waitFor(() =>
      expect(contacts.publishContact).toHaveBeenCalledWith({
        messageId: 'm-1',
        fromRunId: MANAGER,
        toRunId: 'thread-1',
        at: SENT_AT.toISOString(),
        awaitingReply: true,
      }),
    );
    expect(contacts.publishChanged).toHaveBeenCalledWith(['thread-1'], 'items');
  });

  it('relays a reply from a thread to the manager, which no longer awaits one', async () => {
    inbox.awaitingRepliesFrom.mockResolvedValue(new Set());

    agents.publishThreadMessageSent({
      messageId: 'm-2',
      fromRunId: 'thread-1',
      toRunId: MANAGER,
      at: SENT_AT,
      expectsReply: false,
    });

    await vi.waitFor(() =>
      expect(contacts.publishContact).toHaveBeenCalledWith({
        messageId: 'm-2',
        fromRunId: 'thread-1',
        toRunId: MANAGER,
        at: SENT_AT.toISOString(),
        awaitingReply: false,
      }),
    );
  });

  it("re-reads a thread's card once the manager's reply credit on it is spent", () => {
    agents.publishReplyCreditSpent({ fromRunId: MANAGER, toRunId: 'thread-1' });

    expect(contacts.publishChanged).toHaveBeenCalledWith(['thread-1'], 'items');
  });

  it("re-reads a thread's card as its hold, sub-agents, commands and monitors start and end, so its column follows", () => {
    for (const count of [
      { holdingFor: 1 },
      { subagentsOut: 1 },
      { shellsOpen: 1 },
      { monitorsOpen: 1 },
      { holdingFor: 0, subagentsOut: 0, shellsOpen: 0, monitorsOpen: 0 },
    ]) {
      agents.publishRunStatus({ runId: 'thread-1', status: null, ...count });
    }

    expect(contacts.publishChanged).toHaveBeenCalledTimes(5);
    expect(contacts.publishChanged).toHaveBeenCalledWith(
      ['thread-1'],
      'status',
    );
  });

  it('re-reads the cards of every thread archived or unarchived anywhere', () => {
    agents.publishRunsChanged([
      { id: 'thread-1' },
      { id: 'thread-2' },
    ] as unknown as RunWire[]);

    expect(contacts.publishChanged).toHaveBeenCalledWith(
      ['thread-1', 'thread-2'],
      'refiled',
    );
  });

  it('relays nothing for a message between two threads', async () => {
    agents.publishThreadMessageSent({
      messageId: 'm-3',
      fromRunId: 'thread-1',
      toRunId: 'thread-2',
      at: SENT_AT,
      expectsReply: false,
    });

    await vi.waitFor(() => expect(board.managerRunId).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(contacts.publishContact).not.toHaveBeenCalled();
    expect(contacts.publishChanged).not.toHaveBeenCalled();
  });
});
