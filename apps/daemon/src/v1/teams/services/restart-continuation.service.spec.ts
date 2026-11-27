import type { EntityManager } from '@mikro-orm/sqlite';
import { ConflictException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartContinuation } from '../../agents/chat.types';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { ChatService } from '../../agents/services/chat.service';
import {
  callSessionKey,
  nodeSessionKey,
} from '../../agents/utils/session-keys';
import type { Run } from '../../runs/entity/run.entity';
import {
  RESTART_CONTINUE_ATTEMPTS,
  RESTART_CONTINUE_RETRY_MS,
  RestartContinuationService,
} from './restart-continuation.service';
import type { TeamExecutorService } from './team-executor.service';

const TEAM_RECORD: RestartContinuation = {
  cause: 'self-update',
  held: false,
  turns: [{ memberId: 'lead' }],
  calls: [],
  failedCalls: [],
  monitors: [],
};

const CHAT_RECORD: RestartContinuation = {
  cause: 'restart',
  held: false,
  turns: [{ memberId: 'agent' }],
  calls: [],
  failedCalls: [],
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
    continueWithMessage: vi.fn(
      async (): Promise<{
        outcome: 'continued' | 'busy' | 'gone';
        item: Record<string, unknown> | null;
      }> => ({ outcome: 'continued', item: { id: 'row-1' } }),
    ),
    setHeldContinuation: vi.fn(),
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
      '[geniro] The daemon was restarted while you were working. That stop was geniro\'s, not the user\'s: a "user doesn\'t want to proceed" or "stop and wait" note it left in your transcript does not apply. Your session is intact — check what is already done, run the interrupted command again, then carry on. Stopped monitors (not started again): m2 — CI run — `gh run watch 7` (~6 min were left); start them again with monitor if you still need them.',
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

const HELD_RECORD: RestartContinuation = {
  cause: 'unknown',
  held: true,
  turns: [{ memberId: 'lead' }],
  calls: [],
  failedCalls: [],
  monitors: [
    {
      memberId: 'lead',
      conversationId: null,
      id: 'm1',
      description: 'PR checks',
      command: 'gh pr checks 7 --watch',
      remainingMs: null,
    },
    {
      memberId: 'critic',
      conversationId: 'call-2',
      id: 'm2',
      description: 'CI',
      command: 'gh run watch 9',
      remainingMs: null,
    },
  ],
};

describe('RestartContinuationService with runs a crash cut off', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const heldRun = (id: string, extra: Partial<Run> = {}): Partial<Run> => ({
    id,
    teamId: 'crew',
    title: `Run ${id}`,
    status: 'running',
    archivedAt: null,
    restartContinuation: JSON.stringify(HELD_RECORD),
    ...extra,
  });

  it('leaves a held run to the user when it drains', async () => {
    const ctx = setup([heldRun('team-1')]);

    await ctx.service.drain();

    expect(ctx.teams.continueAfterRestart).not.toHaveBeenCalled();
    expect(ctx.rows.get('team-1')!.restartContinuation).not.toBeNull();
  });

  it('forgets the held record of a run archived or stopped since, when it drains', async () => {
    const ctx = setup([
      heldRun('team-1', { archivedAt: new Date() }),
      heldRun('team-2', { status: 'cancelled' }),
      heldRun('team-3'),
    ]);

    await ctx.service.drain();

    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
    expect(ctx.rows.get('team-2')!.restartContinuation).toBeNull();
    expect(ctx.rows.get('team-3')!.restartContinuation).not.toBeNull();
    expect(ctx.teams.continueAfterRestart).not.toHaveBeenCalled();
  });

  it('retries a chosen run still settling a pass, without holding it again', async () => {
    const ctx = setup([heldRun('team-1')]);
    ctx.teams.continueAfterRestart
      .mockResolvedValueOnce('busy')
      .mockResolvedValueOnce('continued');

    await ctx.service.answerHeld({
      continueRunIds: ['team-1'],
      declineRunIds: [],
    });
    expect(
      JSON.parse(ctx.rows.get('team-1')!.restartContinuation!),
    ).toMatchObject({ held: false });

    await vi.advanceTimersByTimeAsync(RESTART_CONTINUE_RETRY_MS);

    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledTimes(2);
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
  });

  it('ends a chosen run whose continuation throws, as a stop nobody continues', async () => {
    const ctx = setup([heldRun('team-1')]);
    ctx.teams.continueAfterRestart.mockRejectedValue(new Error('no folder'));

    await ctx.service.answerHeld({
      continueRunIds: ['team-1'],
      declineRunIds: [],
    });

    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledWith(
      'team-1',
      'unknown',
    );
  });

  it('lists only the held team runs that are neither archived nor stopped', async () => {
    const ctx = setup([
      heldRun('team-1'),
      heldRun('team-2', { archivedAt: new Date() }),
      heldRun('team-4', { status: 'cancelled' }),
      {
        id: 'team-3',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);

    expect(await ctx.service.listHeld()).toEqual([
      { runId: 'team-1', title: 'Run team-1', cause: 'unknown' },
    ]);
  });

  it('continues each chosen run as an update continues it and ends each declined one as a crash does', async () => {
    const ctx = setup([heldRun('team-1'), heldRun('team-2')]);

    const answered = await ctx.service.answerHeld({
      continueRunIds: ['team-1'],
      declineRunIds: ['team-2'],
    });

    expect(answered).toEqual({ continued: ['team-1'], declined: ['team-2'] });
    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledTimes(1);
    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledWith('team-1', {
      ...HELD_RECORD,
      held: false,
    });
    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledTimes(1);
    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledWith(
      'team-2',
      'unknown',
      true,
    );
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
    expect(ctx.rows.get('team-2')!.restartContinuation).toBeNull();
  });

  it('tells each declined run’s monitor owners, in their own conversations, which monitors stopped', async () => {
    const ctx = setup([heldRun('team-2')]);

    await ctx.service.answerHeld({
      continueRunIds: [],
      declineRunIds: ['team-2'],
    });

    expect(ctx.sessions.oweKeyNote).toHaveBeenCalledWith(
      nodeSessionKey('team-2', 'lead'),
      expect.stringContaining('m1 — PR checks — `gh pr checks 7 --watch`'),
    );
    expect(ctx.sessions.oweKeyNote).toHaveBeenCalledWith(
      callSessionKey('team-2', 'call-2'),
      expect.stringContaining('m2 — CI — `gh run watch 9`'),
    );
  });

  it('ends no run that had already settled when it declines one that only lost its monitors', async () => {
    const ctx = setup([heldRun('team-2', { status: 'completed' })]);

    await ctx.service.answerHeld({
      continueRunIds: [],
      declineRunIds: ['team-2'],
    });

    expect(ctx.teams.abandonRestartContinuation).not.toHaveBeenCalled();
    expect(ctx.rows.get('team-2')!.restartContinuation).toBeNull();
    expect(ctx.sessions.oweKeyNote).toHaveBeenCalledTimes(2);
  });

  it('ignores a run that is not held, an unknown one, and a second answer', async () => {
    const ctx = setup([
      heldRun('team-1'),
      {
        id: 'team-3',
        teamId: 'crew',
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);

    const first = await ctx.service.answerHeld({
      continueRunIds: ['team-1', 'team-3', 'nope'],
      declineRunIds: ['team-1'],
    });
    const second = await ctx.service.answerHeld({
      continueRunIds: ['team-1'],
      declineRunIds: [],
    });

    expect(first).toEqual({ continued: ['team-1'], declined: [] });
    expect(second).toEqual({ continued: [], declined: [] });
    expect(ctx.teams.continueAfterRestart).toHaveBeenCalledTimes(1);
    expect(ctx.teams.abandonRestartContinuation).not.toHaveBeenCalled();
  });

  it('makes the team records an earlier stop owed wait for the user, and leaves chats alone', async () => {
    const ctx = setup([
      {
        id: 'team-3',
        teamId: 'crew',
        status: 'running',
        archivedAt: null,
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
      {
        id: 'chat-1',
        teamId: null,
        restartContinuation: JSON.stringify(CHAT_RECORD),
      },
    ]);

    await ctx.service.holdTeamContinuations();
    await ctx.service.drain();

    expect(
      JSON.parse(ctx.rows.get('team-3')!.restartContinuation!),
    ).toMatchObject({ cause: 'self-update', held: true });
    expect(ctx.teams.continueAfterRestart).not.toHaveBeenCalled();
    expect(ctx.chats.sendMessage).toHaveBeenCalledTimes(1);
  });

  function installed(ctx: ReturnType<typeof setup>) {
    ctx.service.onModuleInit();
    const [continueHeld, declineHeld] = ctx.teams.setHeldContinuation.mock
      .calls[0] as unknown as [
      (
        runId: string,
        message: { text: string; images: [] },
      ) => Promise<unknown>,
      (runId: string) => Promise<boolean>,
    ];
    return { continueHeld, declineHeld };
  }

  it('continues a held run with the message the user wrote into it, clearing its record first', async () => {
    const ctx = setup([heldRun('team-1')]);
    const { continueHeld } = installed(ctx);
    let seenAtHandOff: string | null | undefined;
    ctx.teams.continueWithMessage.mockImplementation(async () => {
      seenAtHandOff = ctx.rows.get('team-1')!.restartContinuation;
      return { outcome: 'continued', item: { id: 'row-1' } };
    });

    expect(
      await continueHeld('team-1', { text: 'carry on', images: [] }),
    ).toEqual({ id: 'row-1' });
    expect(ctx.teams.continueWithMessage).toHaveBeenCalledWith(
      'team-1',
      { ...HELD_RECORD, held: false },
      { text: 'carry on', images: [] },
    );
    expect(seenAtHandOff).toBeNull();
  });

  it('keeps a held run held and refuses the message RUN_BUSY while its last pass still finishes', async () => {
    const ctx = setup([heldRun('team-1')]);
    const { continueHeld } = installed(ctx);
    ctx.teams.continueWithMessage.mockResolvedValue({
      outcome: 'busy',
      item: null,
    });

    await expect(
      continueHeld('team-1', { text: 'carry on', images: [] }),
    ).rejects.toMatchObject({ errorCode: 'RUN_BUSY' });
    expect(
      JSON.parse(ctx.rows.get('team-1')!.restartContinuation!),
    ).toMatchObject({ held: true });
  });

  it('leaves a message into a run no longer held to the ordinary delivery', async () => {
    const ctx = setup([
      {
        id: 'team-1',
        teamId: 'crew',
        status: 'running',
        archivedAt: null,
        restartContinuation: JSON.stringify(TEAM_RECORD),
      },
    ]);
    const { continueHeld } = installed(ctx);

    expect(
      await continueHeld('team-1', { text: 'carry on', images: [] }),
    ).toBeNull();
    expect(ctx.teams.continueWithMessage).not.toHaveBeenCalled();
  });

  it('declines a held run its Stop stops', async () => {
    const ctx = setup([heldRun('team-1')]);
    const { declineHeld } = installed(ctx);

    expect(await declineHeld('team-1')).toBe(true);
    expect(ctx.teams.abandonRestartContinuation).toHaveBeenCalledWith(
      'team-1',
      HELD_RECORD.cause,
      true,
    );
    expect(ctx.rows.get('team-1')!.restartContinuation).toBeNull();
  });
});
