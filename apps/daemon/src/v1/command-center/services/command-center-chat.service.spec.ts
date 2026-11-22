import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import type { StartCommandCenterChatInput } from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { managerFolderPath } from '../utils/manager-folder';
import type { CommandCenterService } from './command-center.service';
import { CommandCenterChatService } from './command-center-chat.service';
import type { CommandCenterEventBus } from './command-center-events.bus';

const MANAGER = 'manager-1';
const START = { agentKind: 'claude' } as StartCommandCenterChatInput;

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

describe('CommandCenterChatService', () => {
  let db: Db;
  let created: RunWire;
  let current: RunWire | null;
  let chats: {
    findCommandCenterChat: ReturnType<typeof vi.fn>;
    createChat: ReturnType<typeof vi.fn>;
    refreshTeamInstructions: ReturnType<typeof vi.fn>;
    offeredApproval: ReturnType<typeof vi.fn>;
    deleteCommandCenterChats: ReturnType<typeof vi.fn>;
    moveChatFolder: ReturnType<typeof vi.fn>;
  };
  let board: {
    activeThreads: ReturnType<typeof vi.fn>;
    columnsOf: ReturnType<typeof vi.fn>;
  };
  let events: { publishChanged: ReturnType<typeof vi.fn> };
  let roster: CommandCenterRosterDao;
  let service: CommandCenterChatService;

  async function handlesOf(): Promise<
    { thread: string; handle: string; left: boolean }[]
  > {
    return (await roster.listOf(MANAGER))
      .map((row) => ({
        thread: row.threadRunId,
        handle: row.handle,
        left: row.leftAt !== null,
      }))
      .sort((a, b) => a.thread.localeCompare(b.thread));
  }

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER, { commandCenter: true, title: 'Manager' });
    await db.seedRun('thread-1', { title: 'Billing cache' });
    await db.seedRun('thread-2', { title: 'Docs' });
    await db.seedRun('thread-3', { title: 'Invoices' });

    created = { id: MANAGER } as unknown as RunWire;
    current = null;
    chats = {
      findCommandCenterChat: vi.fn(() => Promise.resolve(current)),
      createChat: vi.fn(() => {
        current = created;
        return Promise.resolve(created);
      }),
      refreshTeamInstructions: vi.fn(() => Promise.resolve()),
      offeredApproval: vi.fn(() => undefined),
      deleteCommandCenterChats: vi.fn(() => Promise.resolve({ deleted: 2 })),
      moveChatFolder: vi.fn(() => Promise.resolve(false)),
    };
    board = {
      activeThreads: vi.fn(() =>
        Promise.resolve({ managerRunId: MANAGER, runs: [] }),
      ),
      columnsOf: vi.fn(() => Promise.resolve(new Map())),
    };
    events = { publishChanged: vi.fn() };
    roster = new CommandCenterRosterDao(db.em);

    service = new CommandCenterChatService(
      db.em,
      chats as unknown as ChatService,
      {
        listRuns: vi.fn(() => Promise.resolve([])),
      } as unknown as TeamExecutorService,
      new AgentEventBus(),
      roster,
      board as unknown as CommandCenterService,
      events as unknown as CommandCenterEventBus,
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  describe('open', () => {
    it('opens one manager chat for racing opens, and reopens that same chat afterwards', async () => {
      const [first, second] = await Promise.all([
        service.open(START),
        service.open(START),
      ]);

      expect(second).toBe(first);
      expect(chats.createChat).toHaveBeenCalledTimes(1);
      expect(chats.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          commandCenter: true,
          projectId: null,
          title: 'Command center',
          cwd: managerFolderPath(),
        }),
      );
      expect(existsSync(managerFolderPath())).toBe(true);
      expect(managerFolderPath()).not.toBe(homedir());

      const again = await service.open(START);

      expect(again).toBe(created);
      expect(chats.createChat).toHaveBeenCalledTimes(1);
      expect(chats.refreshTeamInstructions).toHaveBeenCalledWith(
        MANAGER,
        expect.any(String),
      );
    });

    it("re-briefs an existing manager with the user's standing instructions, and drops them once cleared", async () => {
      current = { id: MANAGER, cwd: managerFolderPath() } as unknown as RunWire;

      service.setInstructions('Answer in Russian.');
      await service.open(START);
      service.setInstructions('');
      await service.open(START);

      const [withText, without] = chats.refreshTeamInstructions.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(withText).toContain(
        "## The user's standing instructions for you\n\nAnswer in Russian.",
      );
      expect(without).not.toContain("The user's standing instructions");
    });

    it('re-briefs byte for byte the same when a roster thread finishes, so a finish never rewrites the brief', async () => {
      current = { id: MANAGER, cwd: managerFolderPath() } as unknown as RunWire;
      board.activeThreads.mockResolvedValue({
        managerRunId: MANAGER,
        runs: [
          { id: 'thread-1', title: 'Billing cache', status: 'completed' },
        ] as unknown as RunWire[],
      });
      board.columnsOf.mockResolvedValue(new Map([['thread-1', 'working']]));
      await service.open(START);
      board.columnsOf.mockResolvedValue(new Map([['thread-1', 'done']]));
      await service.open(START);

      const [working, finished] = chats.refreshTeamInstructions.mock.calls.map(
        (call) => call[1] as string,
      );
      expect(working).toContain('- t1 · Billing cache');
      expect(finished).toBe(working);
    });

    it("creates the manager chat with the user's standing instructions in its brief", async () => {
      service.setInstructions('Keep reports to one line.');

      await service.open(START);

      expect(chats.createChat).toHaveBeenCalledWith(
        expect.objectContaining({
          teamInstructions: expect.stringContaining(
            'Keep reports to one line.',
          ) as unknown,
        }),
      );
    });

    it('moves an existing manager chat into its own folder and answers it as moved', async () => {
      current = { id: MANAGER, cwd: homedir() } as unknown as RunWire;
      const moved = {
        id: MANAGER,
        cwd: managerFolderPath(),
      } as unknown as RunWire;
      chats.moveChatFolder.mockImplementation(() => {
        current = moved;
        return Promise.resolve(true);
      });

      const opened = await service.open(START);

      expect(chats.moveChatFolder).toHaveBeenCalledWith(
        MANAGER,
        managerFolderPath(),
      );
      expect(opened).toBe(moved);
      expect(chats.createChat).not.toHaveBeenCalled();
    });
  });

  describe('addToRoster', () => {
    it('puts a thread on the roster under a fresh handle and announces the change once', async () => {
      await service.addToRoster(MANAGER, ['thread-1'], 'manager');

      expect(events.publishChanged).toHaveBeenCalledTimes(1);
      expect(events.publishChanged).toHaveBeenCalledWith(
        ['thread-1'],
        'roster',
      );
      expect(await handlesOf()).toEqual([
        { thread: 'thread-1', handle: 't1', left: false },
      ]);
    });

    it('writes the manager’s note on the thread it adds, and announces it', async () => {
      await service.addToRoster(
        MANAGER,
        ['thread-1'],
        'manager',
        'watch billing',
      );

      expect(
        (await roster.listOf(MANAGER)).map((row) => [
          row.threadRunId,
          row.note,
        ]),
      ).toEqual([['thread-1', 'watch billing']]);
      expect(events.publishChanged).toHaveBeenCalledTimes(1);
    });

    it('watches the thread it adds only when the manager asked to', async () => {
      await service.addToRoster(MANAGER, ['thread-1'], 'manager', null, true);
      await service.addToRoster(MANAGER, ['thread-2'], 'manager');

      expect(
        Object.fromEntries(
          (await roster.listOf(MANAGER)).map((row) => [
            row.threadRunId,
            row.watch,
          ]),
        ),
      ).toEqual({ 'thread-1': true, 'thread-2': false });
    });

    it('announces nothing for a thread already on the roster', async () => {
      await service.addToRoster(MANAGER, ['thread-1'], 'manager');
      await service.addToRoster(MANAGER, ['thread-1'], 'manager');

      expect(events.publishChanged).toHaveBeenCalledTimes(1);
      expect(await handlesOf()).toEqual([
        { thread: 'thread-1', handle: 't1', left: false },
      ]);
    });

    it('never reuses a handle once its thread has left, and gives a returning thread its own back', async () => {
      await service.addToRoster(MANAGER, ['thread-1', 'thread-2'], 'auto');
      board.activeThreads.mockResolvedValue({
        managerRunId: MANAGER,
        runs: [{ id: 'thread-2' }] as unknown as RunWire[],
      });
      await service.rosterThreads(MANAGER);

      await service.addToRoster(MANAGER, ['thread-3'], 'manager');

      expect(await handlesOf()).toEqual([
        { thread: 'thread-1', handle: 't1', left: true },
        { thread: 'thread-2', handle: 't2', left: false },
        { thread: 'thread-3', handle: 't3', left: false },
      ]);

      await service.addToRoster(MANAGER, ['thread-1'], 'manager');

      expect((await handlesOf())[0]).toEqual({
        thread: 'thread-1',
        handle: 't1',
        left: false,
      });
    });
  });

  describe('rosterThreads', () => {
    it('takes every thread that left the board off the roster at once, each time, and announces it', async () => {
      await service.addToRoster(MANAGER, ['thread-1', 'thread-2'], 'auto');
      events.publishChanged.mockClear();
      board.activeThreads.mockResolvedValue({
        managerRunId: MANAGER,
        runs: [{ id: 'thread-2' }] as unknown as RunWire[],
      });

      await service.rosterThreads(MANAGER);

      expect(events.publishChanged).toHaveBeenLastCalledWith(
        ['thread-1'],
        'roster',
      );

      board.activeThreads.mockResolvedValue({
        managerRunId: MANAGER,
        runs: [],
      });

      const threads = await service.rosterThreads(MANAGER);

      expect(threads).toEqual([]);
      expect(events.publishChanged).toHaveBeenLastCalledWith(
        ['thread-2'],
        'roster',
      );
      expect(await handlesOf()).toEqual([
        { thread: 'thread-1', handle: 't1', left: true },
        { thread: 'thread-2', handle: 't2', left: true },
      ]);
    });
    it('marks the roster threads whose board column is done, a failed one excepted', async () => {
      const runs = [
        { id: 'thread-1', title: 'Billing cache', status: 'completed' },
        { id: 'thread-2', title: 'Docs', status: 'completed' },
        { id: 'thread-3', title: 'Invoices', status: 'failed' },
      ] as unknown as RunWire[];
      board.activeThreads.mockResolvedValue({ managerRunId: MANAGER, runs });
      board.columnsOf.mockResolvedValue(
        new Map([
          ['thread-1', 'done'],
          ['thread-2', 'working'],
          ['thread-3', 'done'],
        ]),
      );

      const threads = await service.rosterThreads(MANAGER);

      expect(
        Object.fromEntries(
          threads.map(({ entry, done }) => [entry.threadRunId, done]),
        ),
      ).toEqual({ 'thread-1': true, 'thread-2': false, 'thread-3': false });
    });
  });

  describe('reset', () => {
    it('discards the manager chat through the chat service and answers what it deleted', async () => {
      await expect(service.reset()).resolves.toEqual({ deleted: 2 });
      expect(chats.deleteCommandCenterChats).toHaveBeenCalledTimes(1);
    });
  });
});
