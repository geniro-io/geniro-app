import type { EntityManager } from '@mikro-orm/sqlite';
import { ConflictException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartContinuation } from '../../agents/chat.types';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { ChatService } from '../../agents/services/chat.service';
import type { Run } from '../../runs/entity/run.entity';
import {
  RESTART_CONTINUE_ATTEMPTS,
  RESTART_CONTINUE_RETRY_MS,
  RestartContinuationService,
} from './restart-continuation.service';
import type { TeamExecutorService } from './team-executor.service';

const TEAM_RECORD: RestartContinuation = {
  cause: 'self-update',
  turns: [{ memberId: 'lead' }],
  calls: [],
  monitors: [],
};

const CHAT_RECORD: RestartContinuation = {
  cause: 'restart',
  turns: [{ memberId: 'agent' }],
  calls: [],
  monitors: [
    {
      memberId: null,
      conversationId: null,
      id: 'm2',
      description: 'CI run',
      command: 'gh run watch 7',
      remainingMs: 360_000,
    },
  ],
};

function setup(runs: Partial<Run>[]) {
  const rows = new Map(runs.map((run) => [run.id!, { ...run } as Run]));
  const runDao = {
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
    listRunsWithRestartContinuation: vi.fn(async () =>
      [...rows.values()].filter((run) => run.restartContinuation !== null),
    ),
    setRestartContinuation: vi.fn(
      async (runId: string, value: string | null) => {
        const run = rows.get(runId);
        if (run) {
          run.restartContinuation = value;
        }
      },
    ),
  };
  const chats = {
    hostTurnHold: vi.fn((): 'wait' | 'closing' | null => null),
    sendMessage: vi.fn(async () => ({})),
    abandonRestartContinuation: vi.fn(async () => undefined),
  };
  const teams = {
    continueAfterRestart: vi.fn(
      async (): Promise<'continued' | 'busy' | 'gone'> => 'continued',
    ),
    abandonRestartContinuation: vi.fn(async () => undefined),
  };
  const sessions = { oweKeyNote: vi.fn(() => true) };
  const em = { fork: () => ({}) } as unknown as EntityManager;
  const service = new RestartContinuationService(
    em,
    runDao as unknown as RunDao,
    chats as unknown as ChatService,
    teams as unknown as TeamExecutorService,
    sessions as unknown as AgentSessionRegistry,
  );
  return { service, runDao, chats, teams, sessions, rows };
}

describe('RestartContinuationService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears a team run’s record, then hands it to the executor', async () => {
    const ctx = setup([
      {
        id: 'team-1',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);
    let seenAtHandOff: string | null | undefined;
    ctx.teams.continueAfterRestart.mockImplementation(async () => {
      seenAtHandOff = ctx.rows.get('team-1')!.restartContinuation;
      return 'continued';
    });

    await ctx.service.drain();

    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledWith(
      'team-1',
      TEAM_RECORD,
    );
    expect(seenAtHandOff).toBeNull();
    expect(ctx.teams.abandonRestartContinuation).not.toHaveBeenCalled();
  });

  it('keeps the record of a run still settling a pass and tries again', async () => {
    const ctx = setup([
      {
        id: 'team-1',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);
    ctx.teams.continueAfterRestart
      .mockResolvedValueOnce('busy')
      .mockResolvedValueOnce('continued');

    await ctx.service.drain();
    expect(ctx.rows.get('team-1')!.restartContinuation).not.toBeNull();

    await vi.advanceTimersByTimeAsync(RESTART_CONTINUE_RETRY_MS);

    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledTimes(2);
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
    expect(ctx.teams.abandonRestartContinuation).not.toHaveBeenCalled();
  });

  it('ends a run that stays busy as a stop nobody continues', async () => {
    const ctx = setup([
      {
        id: 'team-1',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);
    ctx.teams.continueAfterRestart.mockResolvedValue('busy');

    await ctx.service.drain();
    await vi.advanceTimersByTimeAsync(
      RESTART_CONTINUE_RETRY_MS * RESTART_CONTINUE_ATTEMPTS,
    );

    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledWith(
      'team-1',
      'self-update',
    );
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
  });

  it('ends a team run whose continuation throws', async () => {
    const ctx = setup([
      {
        id: 'team-1',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);
    ctx.teams.continueAfterRestart.mockRejectedValue(new Error('no folder'));

    await ctx.service.drain();

    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledWith(
      'team-1',
      'self-update',
    );
  });

  it('continues a chat with a turn of geniro’s own naming its stopped monitor', async () => {
    const ctx = setup([
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);

    await ctx.service.drain();

    expect(ctx.chats.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      '[geniro] The daemon was restarted while you were working. Your session is intact — check what is already done, then carry on. Stopped monitors (not started again): m2 — CI run — `gh run watch 7` (~6 min were left); start them again with monitor if you still need them.',
      [],
      {
        ownTurn: true,
        hostRow: {
          severity: 'info',
          message: 'The daemon was restarted — continuing this chat.',
          woke: true,
        },
      },
    );
    expect(ctx.rows.get('chat-1')!.restartContinuation).toBeNull();
  });

  it.each([
    ['a turn runs or a card waits', 'hold'],
    ['the user’s message took the chat first', 'busy'],
  ] as const)('leaves a chat to the user when %s', async (_why, how) => {
    const ctx = setup([
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);
    if (how === 'hold') {
      ctx.chats.hostTurnHold.mockReturnValue('wait');
    } else {
      ctx.chats.sendMessage.mockRejectedValue(
        new ConflictException('RUN_BUSY', 'busy'),
      );
    }

    await ctx.service.drain();

    expect(ctx.chats.sendMessage).toHaveBeenCalledTimes(how === 'hold' ? 0 : 1);
    expect(ctx.chats.abandonRestartContinuation).not.toHaveBeenCalled();
    expect(ctx.rows.get('chat-1')!.restartContinuation).toBeNull();
    expect(ctx.sessions.oweKeyNote).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('m2 — CI run — `gh run watch 7`'),
    );
  });

  it('owes nothing and ends nothing for a chat archived before its continuation', async () => {
    const ctx = setup([
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);
    ctx.chats.sendMessage.mockRejectedValue(
      new ConflictException('RUN_ARCHIVED', 'archived'),
    );

    await ctx.service.drain();

    expect(ctx.sessions.oweKeyNote).not.toHaveBeenCalled();
    expect(ctx.chats.abandonRestartContinuation).not.toHaveBeenCalled();
  });

  it('ends a chat whose continuation turn cannot start', async () => {
    const ctx = setup([
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);
    ctx.chats.sendMessage.mockRejectedValue(new Error('folder gone'));

    await ctx.service.drain();

    expect(ctx.chats.abandonRestartContinuation).toHaveBeenCalledWith(
      'chat-1',
      'restart',
    );
  });

  it('clears a record it cannot read without continuing anything', async () => {
    const ctx = setup([
      { id: 'team-1', teamId: 'crew', restartContinuation: '{not json' },
    ]);

    await ctx.service.drain();

    expect(ctx.teams.continueAfterRestart).not.toHaveBeenCalled();
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
  });
});
