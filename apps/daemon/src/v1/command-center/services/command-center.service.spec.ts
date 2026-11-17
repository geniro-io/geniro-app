import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ThreadMessageDao } from '../../agents/dao/thread-message.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { ChatService } from '../../agents/services/chat.service';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import type { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import { STRIP_SPAN_MS } from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterStripDao } from '../dao/command-center-strip.dao';
import { CommandCenterService } from './command-center.service';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

/** The run as the chat listing states it, with the fields the board reads. */
function wireOf(run: Run, awaiting: ReadonlySet<string>): RunWire {
  return {
    id: run.id,
    status: run.status,
    title: run.title,
    awaiting: awaiting.has(run.id) ? 'approval' : null,
    outcome: null,
    pullRequests: [],
    lastMessage: null,
    lastActivityAt: null,
    createdAt: run.createdAt.toISOString(),
    taskIdentifier: run.taskIdentifier,
  } as unknown as RunWire;
}

describe('CommandCenterService.board', () => {
  let db: Db;
  let now: number;
  let pending: Set<string>;
  let chats: { listChats: ReturnType<typeof vi.fn> };
  let executor: { listRuns: ReturnType<typeof vi.fn> };
  let service: CommandCenterService;

  beforeEach(async () => {
    db = await commandCenterDb();
    now = Date.now();
    pending = new Set();
    const runDao = new RunDao(db.em);
    chats = {
      listChats: vi.fn(
        async (scope: 'active', page: { runIds?: string[] } = {}) =>
          (await runDao.listChats(scope, db.em.fork(), page)).map((run) =>
            wireOf(run, pending),
          ),
      ),
    };
    executor = {
      listRuns: vi.fn(
        async (scope: 'active', page: { runIds?: string[] } = {}) =>
          (await runDao.listTeamRuns(scope, db.em.fork(), page)).map((run) =>
            wireOf(run, pending),
          ),
      ),
    };
    const bus = new AgentEventBus();
    const inbox = new ThreadInboxService(
      db.em,
      new ThreadMessageDao(db.em),
      runDao,
      bus,
      { oweKeyNote: () => true } as never,
      { warn: async () => undefined } as never,
    );
    service = new CommandCenterService(
      db.em,
      runDao,
      chats as unknown as ChatService,
      executor as unknown as TeamExecutorService,
      {
        runIdsWithPending: () => [...pending],
      } as unknown as ApprovalRegistry,
      inbox,
      new TaskDao(db.em),
      new CommandCenterRosterDao(db.em),
      new CommandCenterStripDao(db.em),
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  /** A chat whose newest transcript row is `ageMs` old. */
  async function seedChatAged(
    id: string,
    ageMs: number,
    extra: Partial<Run> = {},
  ): Promise<void> {
    await db.seedRun(id, extra);
    await db.seedItem(
      id,
      1,
      new Date(now - ageMs),
      'message',
      { text: 'hi' },
      {
        role: 'user',
      },
    );
  }

  it('includes a chat active 23 hours ago in the day window, and excludes one active 25 hours ago until the week window', async () => {
    await seedChatAged('recent', 23 * HOUR);
    await seedChatAged('stale', 25 * HOUR);

    const day = await service.board('24h');
    const week = await service.board('7d');

    expect(day.cards.map((card) => card.run.id)).toEqual(['recent']);
    expect(week.cards.map((card) => card.run.id).sort()).toEqual([
      'recent',
      'stale',
    ]);
  });

  it('includes a running thread and one awaiting a card whatever their age, and no other old thread', async () => {
    await seedChatAged('running-old', 10 * 24 * HOUR, { status: 'running' });
    await seedChatAged('waiting-old', 10 * 24 * HOUR);
    await seedChatAged('idle-old', 10 * 24 * HOUR);
    pending = new Set(['waiting-old']);

    const board = await service.board('24h');

    expect(
      Object.fromEntries(board.cards.map((card) => [card.run.id, card.column])),
    ).toEqual({ 'running-old': 'working', 'waiting-old': 'waiting' });
  });

  it('never shows the manager or an app-own chat, running or not', async () => {
    await db.seedRun('manager', { commandCenter: true, status: 'running' });
    await db.seedItem(
      'manager',
      1,
      new Date(now - MINUTE),
      'message',
      { text: 'x' },
      { role: 'user' },
    );
    await seedChatAged('project-chat', HOUR, {
      editsProjectId: 'p1',
      status: 'running',
    });
    await seedChatAged('builder-chat', HOUR, { editsTeamSlug: 'team-a' });
    await seedChatAged('analysis', HOUR, { analysisSourceRunId: 'thread-x' });
    await seedChatAged('plain-chat', HOUR);
    await db.seedRoster('manager', 'plain-chat', 't1', {
      note: 'waits for schema',
    });

    const board = await service.board('24h');

    expect(board.managerRunId).toBe('manager');
    expect(board.cards.map((card) => card.run.id)).toEqual(['plain-chat']);
    expect(board.cards[0]).toMatchObject({
      handle: 't1',
      note: 'waits for schema',
    });
  });

  it('places each thread in its column: working, waiting, idle, in review, done', async () => {
    await seedChatAged('done-card', HOUR);
    await db.seedTask('done-card', 'done');
    await seedChatAged('review-card', HOUR);
    await db.seedTask('review-card', 'in_review');
    await seedChatAged('idle-card', HOUR);

    const board = await service.board('24h');

    expect(
      Object.fromEntries(board.cards.map((card) => [card.run.id, card.column])),
    ).toEqual({
      'done-card': 'done',
      'review-card': 'in_review',
      'idle-card': 'idle',
    });
  });

  it('names the board card each thread works, and none for a thread no card started', async () => {
    await seedChatAged('card-run', HOUR, { taskIdentifier: 'GEN-12' });
    await db.seedTask('card-run', 'in_progress', { title: 'Fix login' });
    await seedChatAged('loose-run', HOUR);

    const board = await service.board('24h');
    const taskOf = Object.fromEntries(
      board.cards.map((card) => [card.run.id, card.task]),
    );

    expect(taskOf['card-run']).toEqual({
      id: expect.any(String),
      identifier: 'GEN-12',
      title: 'Fix login',
      status: 'in_progress',
    });
    expect(taskOf['loose-run']).toBeNull();
  });

  it('folds a strip over every row of the eight hours, past any listing cap, and none older', async () => {
    const pairs = 250;
    const first = now - 7 * HOUR;
    await db.seedRun('busy');
    let seq = 1;
    await db.seedItem('busy', seq++, new Date(now - 9 * HOUR), 'status', {
      status: 'running',
    });
    await db.seedItem(
      'busy',
      seq++,
      new Date(now - 8.5 * HOUR),
      'turn_complete',
      {},
    );
    for (let index = 0; index < pairs; index += 1) {
      const start = first + index * 90_000;
      await db.seedItem('busy', seq++, new Date(start), 'status', {
        status: 'running',
      });
      await db.seedItem(
        'busy',
        seq++,
        new Date(start + MINUTE),
        'turn_complete',
        {},
      );
    }

    const board = await service.board('24h');
    const busy = board.cards.find((card) => card.run.id === 'busy');

    expect(busy).toBeDefined();
    const work = busy!.strip.spans.filter((span) => span.kind === 'work');
    expect(work).toHaveLength(pairs);
    expect(
      work.every(
        (span) => Date.parse(span.start) >= Date.parse(board.stripStart),
      ),
    ).toBe(true);
    expect(Date.parse(board.generatedAt) - Date.parse(board.stripStart)).toBe(
      STRIP_SPAN_MS,
    );
  });
});
