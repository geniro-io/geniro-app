import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { OwnedCardHost } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { ChatService } from '../../agents/services/chat.service';
import type { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../__tests__/team-builders';
import type {
  RunTeamChange,
  RunTeamChangeRequest,
  RunTeamProposal,
  RunTeamStartRequest,
  Team,
} from '../teams.types';
import { runTeamHashOf } from '../utils/team-snapshot';
import { ChatTeamService } from './chat-team.service';
import type { RunTeamService } from './run-team.service';
import type { TeamExecutorService } from './team-executor.service';
import type { TeamHealthService } from './team-health.service';

interface Row {
  seq: number;
  kind: string;
  memberId: string;
  inCall: string | null;
  toolNameLower: string | null;
}

const RUN_TEAM = 'mcp__geniro__run_team';

const dev = {
  id: 'dev',
  name: 'Dev',
  role: 'Writes the code',
  task: 'Build it',
  instructions: 'Be exact',
  agent: 'claude' as const,
};

function chatRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    teamId: null,
    teamOrigin: null,
    teamSnapshot: null,
    teamDeparted: null,
    currentLead: null,
    approval: 'plan',
    agentKind: 'claude',
    model: 'sonnet',
    effort: 'high',
    configDir: null,
    editsTeamSlug: null,
    editsProjectId: null,
    commandCenter: false,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    analysisPurpose: null,
    archivedAt: null,
    pendingQuestion: null,
    restartContinuation: null,
    ...overrides,
  } as unknown as Run;
}

function teamRunOf(runId: string, team: Team): Run {
  return chatRun({
    id: runId,
    teamId: `chat:${runId}`,
    teamOrigin: 'chat',
    teamSnapshot: JSON.stringify(team),
    currentLead: 'agent',
  });
}

const lead = member('agent', { name: 'This chat' });
const startRequest: RunTeamStartRequest = {
  summary: 'Build the feature',
  reason: 'The user asked for a team',
  plan: ['Read the spec', 'Build it'],
  team: { name: 'Builders', members: [dev] },
};

function startProposal(): RunTeamProposal {
  return {
    mode: 'run-start',
    team: teamOf([
      lead,
      member('dev', {
        name: 'Dev',
        role: 'Writes the code',
        agent: 'claude',
        approval: 'ask',
      }),
    ]),
    slug: '',
    summary: 'Build the feature',
    reason: 'The user asked for a team',
    autoAgents: [],
    plan: ['Read the spec', 'Build it'],
    lead: {
      memberId: 'agent',
      name: 'This chat',
      role: '',
      agent: 'claude',
      model: 'sonnet',
      approval: 'ask',
    },
    members: [
      {
        member: {
          memberId: 'dev',
          name: 'Dev',
          role: 'Writes the code',
          agent: 'claude',
          model: null,
          approval: 'ask',
        },
        task: 'Build it',
      },
    ],
  };
}

function changeProposal(changes: RunTeamChange[], team: Team): RunTeamProposal {
  return {
    mode: 'run-change',
    team,
    slug: 'run-1',
    summary: 'Change the team',
    reason: 'The user asked',
    autoAgents: [],
    baseHash: 'base-hash',
    changes,
    diff: { members: [] },
  } as unknown as RunTeamProposal;
}

function build() {
  const runs = new Map<string, Run>();
  let team = teamOf([
    lead,
    member('dev', { name: 'Dev', role: 'Writes the code', agent: 'claude' }),
  ]);
  let missing: string[] = [];
  let blockers: string[] = [];
  const rows: Row[] = [];
  const held: (() => Promise<void>)[] = [];

  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn(async (id: string) => runs.get(id) ?? null),
  } as unknown as RunDao;
  const itemDao = {
    rowsOfKindsBetween: vi.fn(
      async (_runId: string, kinds: string[], from: number) =>
        rows.filter((row) => kinds.includes(row.kind) && row.seq >= from),
    ),
  } as unknown as ItemDao;
  const chats = {
    promotionBlockers: vi.fn(async () => blockers),
    whenTurnEnds: vi.fn((_runId: string, action: () => Promise<void>) => {
      held.push(action);
    }),
    recordOwnedCardVerdict: vi.fn(async () => undefined),
    releaseForTeam: vi.fn(),
  } as unknown as ChatService;
  const executor = {
    assertRunnable: vi.fn(async () => undefined),
    promoteChat: vi.fn(async (runId: string, promoted: Team) => {
      runs.set(runId, teamRunOf(runId, promoted));
      team = promoted;
      return true;
    }),
    openChatTeamPass: vi.fn(async () => 7),
    changeRunTeam: vi.fn(async (_runId: string, next: Team) => ({
      status: 'changed' as const,
      reaches: 'now' as const,
      team: next,
      departed: [] as string[],
    })),
    writeRunNote: vi.fn(async () => undefined),
  } as unknown as TeamExecutorService;
  const runTeams = {
    teamOf: vi.fn(async () => team),
  } as unknown as RunTeamService;
  const health = {
    missingClis: vi.fn(async () => missing),
  } as unknown as TeamHealthService;
  const cards = {
    deliverOwnedCardVerdict: vi.fn(async () => undefined),
  } as unknown as OwnedCardHost & {
    deliverOwnedCardVerdict: ReturnType<typeof vi.fn>;
  };

  const service = new ChatTeamService(
    em,
    runDao,
    itemDao,
    chats,
    executor,
    runTeams,
    health,
  );
  return {
    service,
    runs,
    rows,
    held,
    chats: chats as unknown as Record<string, ReturnType<typeof vi.fn>>,
    executor: executor as unknown as Record<string, ReturnType<typeof vi.fn>>,
    cards,
    setTeam: (next: Team) => {
      team = next;
    },
    setMissing: (next: string[]) => {
      missing = next;
    },
    setBlockers: (next: string[]) => {
      blockers = next;
    },
  };
}

describe('ChatTeamService.prepareStart', () => {
  it.each([
    [
      'an analysis',
      { analysisSourceRunId: 'src' },
      'an analysis cannot become a team',
    ],
    [
      'a builder chat',
      { editsTeamSlug: 'dev-team' },
      "a team's builder chat cannot become a team",
    ],
    [
      'a project chat',
      { editsProjectId: 'p1' },
      "a project's own chat cannot become a team",
    ],
    [
      'the command center',
      { commandCenter: true },
      'the command center cannot become a team',
    ],
    ['a team run', { teamId: 'chat:run-1' }, 'this chat already runs a team'],
  ])('refuses a start from %s', async (_name, overrides, message) => {
    const t = build();
    t.runs.set('run-1', chatRun(overrides));

    const result = await t.service.prepareStart('run-1', startRequest);

    expect(result).toEqual({ ok: false, code: 'NOT_STARTABLE_HERE', message });
  });

  it('refuses a start the chat cannot take now, listing each cause', async () => {
    const t = build();
    t.runs.set('run-1', chatRun());
    t.setBlockers([
      'a turn of this chat is still running',
      'another card is waiting for the user — let them answer it first',
    ]);

    const result = await t.service.prepareStart('run-1', startRequest);

    expect(result).toEqual({
      ok: false,
      code: 'NOT_STARTABLE_NOW',
      message:
        'a turn of this chat is still running; another card is waiting for the user — let them answer it first',
    });
    expect(t.chats.promotionBlockers).toHaveBeenCalledWith(
      'run-1',
      null,
      false,
    );
  });

  it('refuses a start naming a CLI this Mac does not have', async () => {
    const t = build();
    t.runs.set('run-1', chatRun());
    t.setMissing(['codex']);

    const result = await t.service.prepareStart('run-1', startRequest);

    expect(result).toEqual({
      ok: false,
      code: 'CLI_NOT_INSTALLED',
      message: 'not installed on this Mac: codex — pick an installed CLI',
    });
  });

  it("builds a run-start card led by the chat's own agent, with its settings and the chat's approval as a member's", async () => {
    const t = build();
    t.runs.set('run-1', chatRun());

    const result = await t.service.prepareStart('run-1', startRequest);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const proposal = result.proposal;
    expect(proposal).toMatchObject({
      mode: 'run-start',
      slug: '',
      plan: ['Read the spec', 'Build it'],
      lead: {
        memberId: 'agent',
        agent: 'claude',
        model: 'sonnet',
        approval: 'ask',
      },
      members: [
        { member: { memberId: 'dev', approval: 'ask' }, task: 'Build it' },
      ],
    });
    if (proposal.mode !== 'run-start') {
      return;
    }
    expect(proposal.team.members[0]).toMatchObject({
      id: 'agent',
      name: 'This chat',
      agent: 'claude',
      model: 'sonnet',
      effort: 'high',
      approval: 'ask',
    });
    expect(proposal.team.members[1]).toMatchObject({
      id: 'dev',
      approval: 'ask',
    });
    expect(proposal.team.triggers).toEqual([
      { kind: 'first-message', member: 'agent' },
    ]);
    expect(t.chats.promotionBlockers).toHaveBeenCalledWith(
      'run-1',
      null,
      false,
    );
  });
});

describe('ChatTeamService.prepareChange', () => {
  function teamRun(
    t: ReturnType<typeof build>,
    departed: string | null = null,
  ): Run {
    const team = teamOf([
      lead,
      member('dev', { name: 'Dev', role: 'Writes the code', agent: 'claude' }),
      member('qa', { name: 'QA', role: 'Tests', agent: 'claude' }),
    ]);
    t.setTeam(team);
    const run = teamRunOf('run-1', team);
    const stored = { ...run, teamDeparted: departed };
    t.runs.set('run-1', stored);
    return stored;
  }

  it('builds a change card for an add, with its diff and the base hash of the run copy', async () => {
    const t = build();
    const run = teamRun(t);
    const request: RunTeamChangeRequest = {
      summary: 'Add a reviewer',
      reason: 'More checks',
      edits: [
        {
          op: 'add',
          member: {
            id: 'rev',
            name: 'Rev',
            role: 'Reviews',
            task: 'Review it',
            instructions: 'Be strict',
            agent: 'claude',
          },
        },
      ],
    };

    const result = await t.service.prepareChange('run-1', request);

    expect(result.ok).toBe(true);
    if (!result.ok || result.proposal.mode !== 'run-change') {
      return;
    }
    expect(result.proposal.baseHash).toBe(runTeamHashOf(run.teamSnapshot));
    expect(result.proposal.changes).toEqual([
      {
        op: 'add',
        member: expect.objectContaining({ memberId: 'rev', name: 'Rev' }),
        task: 'Review it',
      },
    ]);
    expect(result.proposal.diff).toBeDefined();
  });

  it('builds a remove and an update, the update naming the fields that changed', async () => {
    const t = build();
    teamRun(t);

    const removed = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [{ op: 'remove', memberId: 'qa' }],
    });
    expect(
      removed.ok &&
        removed.proposal.mode === 'run-change' &&
        removed.proposal.changes,
    ).toEqual([{ op: 'remove', memberId: 'qa', name: 'QA' }]);

    const updated = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [{ op: 'update', memberId: 'dev', role: 'Reviews the code' }],
    });
    expect(
      updated.ok &&
        updated.proposal.mode === 'run-change' &&
        updated.proposal.changes,
    ).toEqual([
      {
        op: 'update',
        memberId: 'dev',
        name: 'Dev',
        fields: [
          {
            field: 'role',
            before: 'Writes the code',
            after: 'Reviews the code',
          },
        ],
        task: null,
      },
    ]);
  });

  it("refuses to remove the chat's own agent, the lead", async () => {
    const t = build();
    teamRun(t);

    const result = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [{ op: 'remove', memberId: 'agent' }],
    });

    expect(result).toMatchObject({ ok: false, code: 'LEAD_STAYS' });
  });

  it('refuses an edit to an agent the team does not have', async () => {
    const t = build();
    teamRun(t);

    const result = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [{ op: 'remove', memberId: 'ghost' }],
    });

    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_MEMBER' });
  });

  it('refuses to re-add an id that has departed from the run', async () => {
    const t = build();
    teamRun(
      t,
      JSON.stringify([{ memberId: 'qa', leftAt: '2026-11-25T10:00:00.000Z' }]),
    );

    const result = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [
        {
          op: 'add',
          member: {
            id: 'qa',
            name: 'QA',
            role: 'Tests',
            task: 't',
            instructions: 'i',
            agent: 'claude',
          },
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, code: 'MEMBER_EXISTS' });
  });

  it('refuses a change that would take a chat team over twelve agents', async () => {
    const t = build();
    const twelve = Array.from({ length: 12 }, (_, at) =>
      member(`m${at}`, { name: `M${at}`, agent: 'claude' }),
    );
    const run = teamRunOf('run-1', teamOf([lead, ...twelve]));
    t.runs.set('run-1', run);
    t.setTeam(teamOf([lead, ...twelve]));

    const result = await t.service.prepareChange('run-1', {
      summary: 's',
      reason: 'r',
      edits: [
        {
          op: 'add',
          member: {
            id: 'extra',
            name: 'Extra',
            role: 'x',
            task: 't',
            instructions: 'i',
            agent: 'claude',
          },
        },
      ],
    });

    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_MEMBERS' });
  });
});

describe('ChatTeamService.carryOutVerdict', () => {
  it('records a declined start and starts nothing', async () => {
    const t = build();

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      startProposal(),
      false,
      undefined,
      t.cards,
    );

    expect(t.cards.deliverOwnedCardVerdict).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      false,
      '(Declined — no team was started.)',
      undefined,
    );
    expect(t.executor.promoteChat).not.toHaveBeenCalled();
  });

  it('holds an allowed start until the chat’s turn ends', async () => {
    const t = build();

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      startProposal(),
      true,
      undefined,
      t.cards,
    );

    expect(t.chats.whenTurnEnds).toHaveBeenCalledWith(
      'run-1',
      expect.any(Function),
    );
    expect(t.chats.promotionBlockers).not.toHaveBeenCalled();
    expect(t.executor.promoteChat).not.toHaveBeenCalled();
  });

  it('records a start the press found blocked, with its causes, and promotes nothing', async () => {
    const t = build();
    t.runs.set('run-1', chatRun());
    t.setBlockers(['a turn of this chat is still running']);

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      startProposal(),
      true,
      undefined,
      t.cards,
    );
    await t.held[0]!();

    expect(t.chats.promotionBlockers).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      true,
    );
    expect(t.cards.deliverOwnedCardVerdict).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      true,
      '(Not started — a turn of this chat is still running. Close what is named, then propose the team again with run_team.)',
      undefined,
      { kind: 'not-started', causes: ['a turn of this chat is still running'] },
    );
    expect(t.executor.promoteChat).not.toHaveBeenCalled();
    expect(t.chats.releaseForTeam).not.toHaveBeenCalled();
  });

  it('starts the team once no turn runs: records it, releases the chat, then promotes it with the plan, the tasks and the note', async () => {
    const t = build();
    t.runs.set('run-1', chatRun());

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      startProposal(),
      true,
      'Keep it short',
      t.cards,
    );
    await t.held[0]!();

    expect(t.chats.recordOwnedCardVerdict).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      true,
      {
        answer: 'Keep it short',
        outcome: { kind: 'started' },
      },
    );
    expect(t.chats.releaseForTeam).toHaveBeenCalledWith('run-1');
    expect(t.executor.promoteChat).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ members: expect.any(Array) }),
    );
    const open = t.executor.openChatTeamPass as ReturnType<typeof vi.fn>;
    expect(open).toHaveBeenCalledWith(
      'run-1',
      expect.stringContaining('1. Read the spec'),
      'This chat is now a team: Dev joined it.',
    );
    const prompt = open.mock.calls[0]![1] as string;
    expect(prompt).toContain('2. Build it');
    expect(prompt).toContain(
      'Dev (id dev, claude): Writes the code Task: Build it',
    );
    expect(prompt).toContain("The user's note: Keep it short");
    expect(
      (t.chats.releaseForTeam as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0]!,
    ).toBeLessThan(open.mock.invocationCallOrder[0]!);
  });

  it('applies an allowed change: the removed ids go to the executor, and the card records it changed', async () => {
    const t = build();
    t.runs.set(
      'run-1',
      teamRunOf(
        'run-1',
        teamOf([lead, member('dev', { name: 'Dev', agent: 'claude' })]),
      ),
    );
    const next = teamOf([lead]);
    const proposal = changeProposal(
      [{ op: 'remove', memberId: 'dev', name: 'Dev' }],
      next,
    );

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      proposal,
      true,
      undefined,
      t.cards,
    );

    expect(t.executor.changeRunTeam).toHaveBeenCalledWith(
      'run-1',
      next,
      'base-hash',
      ['dev'],
    );
    expect(t.cards.deliverOwnedCardVerdict).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      true,
      expect.stringContaining('(Applied — The team now: '),
      undefined,
      { kind: 'changed' },
    );
  });

  it('records a change the executor refuses as not changed, with its reason', async () => {
    const t = build();
    t.runs.set('run-1', teamRunOf('run-1', teamOf([lead])));
    (
      t.executor.changeRunTeam as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      status: 'refused',
      reason: 'the team changed since the card was raised',
    });
    const proposal = changeProposal(
      [{ op: 'remove', memberId: 'dev', name: 'Dev' }],
      teamOf([lead]),
    );

    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      proposal,
      true,
      undefined,
      t.cards,
    );

    expect(t.cards.deliverOwnedCardVerdict).toHaveBeenCalledWith(
      'run-1',
      'req-1',
      true,
      '(Not applied — the team changed since the card was raised. Propose the change again with run_team.)',
      undefined,
      {
        kind: 'not-changed',
        reason: 'the team changed since the card was raised',
      },
    );
  });
});

describe('ChatTeamService.applyRemarkChange', () => {
  const addRequest: RunTeamChangeRequest = {
    summary: 'Add a reviewer',
    reason: 'More checks',
    edits: [
      {
        op: 'add',
        member: {
          id: 'rev',
          name: 'Rev',
          role: 'Reviews',
          task: 'Review it',
          instructions: 'Be strict',
          agent: 'claude',
        },
      },
    ],
  };

  /** Starts a team with a note, so the lead's first turn holds the one-change grant. */
  async function startedWithNote(t: ReturnType<typeof build>): Promise<void> {
    t.runs.set('run-1', chatRun());
    await t.service.carryOutVerdict(
      'run-1',
      'req-1',
      startProposal(),
      true,
      'Add a reviewer',
      t.cards,
    );
    await t.held[0]!();
  }

  it('answers null when no start with a note granted the change', async () => {
    const t = build();
    t.runs.set(
      'run-1',
      teamRunOf('run-1', teamOf([lead, member('dev', { agent: 'claude' })])),
    );

    expect(await t.service.applyRemarkChange('run-1', addRequest)).toBeNull();
    expect(t.executor.changeRunTeam).not.toHaveBeenCalled();
  });

  it('applies one add at once: writes its row, changes the run, and says so', async () => {
    const t = build();
    await startedWithNote(t);

    const answer = await t.service.applyRemarkChange('run-1', addRequest);

    expect(answer).toContain(
      "Applied per the user's note, with no card: + Rev joins.",
    );
    expect(t.executor.writeRunNote).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        severity: 'info',
        chatTeam: {
          phase: 'changed',
          remark: true,
          changes: [expect.objectContaining({ op: 'add' })],
        },
      }),
    );
    expect(t.executor.changeRunTeam).toHaveBeenCalledWith(
      'run-1',
      expect.anything(),
      expect.any(String),
      [],
    );
  });

  it('spends the grant: a second change in the same turn goes on a card', async () => {
    const t = build();
    await startedWithNote(t);
    await t.service.applyRemarkChange('run-1', addRequest);

    expect(await t.service.applyRemarkChange('run-1', addRequest)).toBeNull();
  });

  it('answers null for a remove, which always goes on a card', async () => {
    const t = build();
    await startedWithNote(t);

    expect(
      await t.service.applyRemarkChange('run-1', {
        summary: 's',
        reason: 'r',
        edits: [{ op: 'remove', memberId: 'dev' }],
      }),
    ).toBeNull();
    expect(t.executor.changeRunTeam).not.toHaveBeenCalled();
  });

  it('answers null for two edits in one call', async () => {
    const t = build();
    await startedWithNote(t);

    expect(
      await t.service.applyRemarkChange('run-1', {
        summary: 's',
        reason: 'r',
        edits: [
          addRequest.edits[0]!,
          { op: 'update', memberId: 'dev', role: 'x' },
        ],
      }),
    ).toBeNull();
  });

  it('answers null once the lead has made another tool call in its turn', async () => {
    const t = build();
    await startedWithNote(t);
    t.rows.push({
      seq: 8,
      kind: 'tool_call',
      memberId: 'agent',
      inCall: null,
      toolNameLower: 'mcp__geniro__call_agent',
    });

    expect(await t.service.applyRemarkChange('run-1', addRequest)).toBeNull();
  });

  it('answers null once the lead’s turn has completed', async () => {
    const t = build();
    await startedWithNote(t);
    t.rows.push({
      seq: 8,
      kind: 'turn_complete',
      memberId: 'agent',
      inCall: null,
      toolNameLower: null,
    });

    expect(await t.service.applyRemarkChange('run-1', addRequest)).toBeNull();
  });

  it('still applies when the only tool call before it was run_team', async () => {
    const t = build();
    await startedWithNote(t);
    t.rows.push({
      seq: 8,
      kind: 'tool_call',
      memberId: 'agent',
      inCall: null,
      toolNameLower: RUN_TEAM,
    });

    expect(await t.service.applyRemarkChange('run-1', addRequest)).toContain(
      "Applied per the user's note",
    );
  });
});
