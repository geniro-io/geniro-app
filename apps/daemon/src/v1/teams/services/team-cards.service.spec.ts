import { describe, expect, it, vi } from 'vitest';

import { fakeEntityManager } from '../../agents/__tests__/fake-entity-manager';
import {
  HOST_PLUGIN_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_QUESTION_TOOL,
  type HostPluginProposal,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import type { ChatService } from '../../agents/services/chat.service';
import { ChatArtifactsService } from '../../agents/services/chat-artifacts.service';
import type { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import type { PluginProposalBroker } from '../../agents/services/plugin-proposal.broker';
import type { ProjectInstructionsChangeService } from '../../agents/services/project-instructions-change.service';
import { QuestionAttachmentsService } from '../../agents/services/question-attachments.service';
import { QUESTION_ALREADY_STANDING } from '../../agents/utils/pending-question';
import { serializeTeamProjectCard } from '../../agents/utils/team-project-card';
import type { StageWakeService } from './stage-wake.service';
import { TeamCardsService } from './team-cards.service';
import type { TeamExecutorService } from './team-executor.service';

interface FakeRun {
  id: string;
  teamId: string | null;
  archivedAt: Date | null;
  pendingTeamProjectCard: string | null;
  pendingMemberQuestions: string | null;
}

interface Row {
  runId: string;
  memberId: string | null;
  kind: string;
  payload: Record<string, unknown>;
}

const RUN = 'team-run-1';

const CHANGE: HostProjectInstructions = {
  projectId: 'p1',
  project: 'Geniro',
  previous: 'Use pnpm.',
  next: 'Use pnpm.\n\nRun the full check.',
  blocks: [
    { id: 'repo', title: 'Repo', text: 'Use pnpm.' },
    { id: 'check', title: 'Check', text: 'Run the full check.' },
  ],
  baseRevision: 2,
  ids: [],
  cardSeq: null,
};

function harness(
  write: (
    runId: string,
    change: HostProjectInstructions,
  ) => Promise<HostProjectInstructionsOutcome> = () =>
    Promise.resolve({ status: 'saved', instructionsRevision: 3 }),
) {
  const runs = new Map<string, FakeRun>([
    [
      RUN,
      {
        id: RUN,
        teamId: 'team',
        archivedAt: null,
        pendingTeamProjectCard: null,
        pendingMemberQuestions: null,
      },
    ],
  ]);
  const rows: Row[] = [];
  let seq = 0;
  const knobs = {
    /** Set to make the next column write of this value fail. */
    failColumnWrite: null as ((value: string | null) => boolean) | null,
    /** Answers whether the run is archived, per check. */
    archived: (id: string) => (runs.get(id)?.archivedAt ?? null) !== null,
  };
  const approvals = new ApprovalRegistry();
  const wakeLead = vi.fn(() => Promise.resolve(true));
  const writeChange = vi.fn(write);
  const announceAwaiting = vi.fn();
  const useLeadProjectCards = vi.fn();
  const writePlugin = vi.fn(() =>
    Promise.resolve({
      status: 'saved' as const,
      slug: 'deploys',
      path: '/data/plugins/deploys.plugin.yaml',
    }),
  );
  const runDao = {
    getById: (id: string) => Promise.resolve(runs.get(id) ?? null),
    setPendingTeamProjectCard: (id: string, value: string | null) => {
      if (knobs.failColumnWrite?.(value)) {
        return Promise.reject(new Error('SQLITE_BUSY'));
      }
      runs.get(id)!.pendingTeamProjectCard = value;
      return Promise.resolve();
    },
    listRunsWithPendingTeamProjectCard: () =>
      Promise.resolve(
        [...runs.values()].filter((run) => run.pendingTeamProjectCard !== null),
      ),
    setPendingMemberQuestions: (id: string, value: string | null) => {
      runs.get(id)!.pendingMemberQuestions = value;
      return Promise.resolve();
    },
    listRunsWithPendingMemberQuestions: () =>
      Promise.resolve(
        [...runs.values()].filter((run) => run.pendingMemberQuestions !== null),
      ),
  };
  const itemDao = {
    create: (data: {
      runId: string;
      memberId: string | null;
      kind: string;
      payload: string;
    }) => {
      rows.push({
        runId: data.runId,
        memberId: data.memberId,
        kind: data.kind,
        payload: JSON.parse(data.payload) as Record<string, unknown>,
      });
      return Promise.resolve({
        id: `item-${rows.length}`,
        createdAt: new Date(),
      });
    },
    artifactRows: (runId: string) =>
      Promise.resolve(
        rows
          .filter((row) => row.runId === runId && row.kind === 'show_artifact')
          .map((row) => ({
            seq: 0,
            payload: JSON.stringify(row.payload),
            createdAt: new Date(0),
          })),
      ),
    rowsOfKinds: () => Promise.resolve([]),
    rowsOfKindsBetween: () => Promise.resolve([]),
    latestUserMessage: () => Promise.resolve(null),
    rowsByPayloadId: (runId: string, kinds: string[], ids: string[]) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.runId === runId &&
            kinds.includes(row.kind) &&
            ids.includes(row.payload.id as string),
        ),
      ),
  };
  const questionAttachments = new QuestionAttachmentsService(
    new ChatArtifactsService(
      fakeEntityManager(),
      runDao as unknown as RunDao,
      itemDao as unknown as ItemDao,
      {} as unknown as ArtifactStoreService,
    ),
  );
  const service = new TeamCardsService(
    fakeEntityManager(),
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    {
      reserve: () => Promise.resolve((seq += 1)),
      settle: () => undefined,
    } as unknown as ItemSeqAllocator,
    { inCallOf: () => Promise.resolve('') } as unknown as ItemCallIndexService,
    new AgentEventBus(),
    approvals,
    {
      isArchived: (id: string) => Promise.resolve(knobs.archived(id)),
    } as unknown as ChatService,
    {
      currentLead: () => Promise.resolve('lead'),
      announceAwaiting,
      useLeadProjectCards,
      useLeadPluginCards: vi.fn(),
      useMemberQuestionCards: vi.fn(),
    } as unknown as TeamExecutorService,
    { wakeLead } as unknown as StageWakeService,
    { write: writeChange } as unknown as ProjectInstructionsChangeService,
    { write: writePlugin } as unknown as PluginProposalBroker,
    questionAttachments,
  );
  const rowsOf = (kind: string) => rows.filter((row) => row.kind === kind);
  return {
    service,
    runs,
    rows,
    itemDao,
    rowsOf,
    approvals,
    wakeLead,
    writeChange,
    writePlugin,
    announceAwaiting,
    useLeadProjectCards,
    knobs,
  };
}

/** Wait until the press has been carried out to its last step, the lead's wake. */
async function settle(wakeLead: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => expect(wakeLead).toHaveBeenCalled());
}

const POSTED = { status: 'posted', buttons: 'Approve or Deny' };

describe('TeamCardsService', () => {
  it("puts the lead's project card in the lead's own flow, answers at once and stands one card per run", async () => {
    const { service, runs, rowsOf, approvals } = harness();

    expect(await service.proposeProjectInstructions(RUN, CHANGE)).toEqual(
      POSTED,
    );
    const [request] = rowsOf('approval_request');
    expect(request).toMatchObject({
      runId: RUN,
      memberId: 'lead',
      payload: { nodeId: 'lead', toolName: HOST_PROJECT_INSTRUCTIONS_TOOL },
    });
    const requestId = request!.payload.id as string;
    expect(JSON.parse(runs.get(RUN)!.pendingTeamProjectCard!)).toMatchObject({
      requestId,
    });
    expect(approvals.listByRun(RUN).map((entry) => entry.requestId)).toEqual([
      requestId,
    ]);

    expect(await service.proposeProjectInstructions(RUN, CHANGE)).toEqual(
      POSTED,
    );
    expect(
      await service.proposeProjectInstructions(RUN, {
        ...CHANGE,
        next: 'Something else.',
        blocks: [{ id: 'repo', title: 'Repo', text: 'Something else.' }],
      }),
    ).toEqual({ status: 'unavailable', reason: QUESTION_ALREADY_STANDING });
    expect(rowsOf('approval_request')).toHaveLength(1);
  });

  it('writes the change on Apply, records the verdict and wakes the lead with what was saved', async () => {
    const { service, runs, rowsOf, approvals, wakeLead, writeChange } =
      harness();
    await service.proposeProjectInstructions(RUN, CHANGE);
    const requestId = rowsOf('approval_request')[0]!.payload.id as string;

    expect(approvals.resolve(RUN, requestId, true)).toBe(true);
    await settle(wakeLead);

    expect(writeChange).toHaveBeenCalledWith(RUN, CHANGE);
    expect(runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
    expect(rowsOf('approval_verdict')).toEqual([
      expect.objectContaining({
        memberId: 'lead',
        payload: {
          id: requestId,
          nodeId: 'lead',
          allow: true,
          outcome: 'saved',
          answer: 'saved as revision 3',
        },
      }),
    ]);
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'lead',
      `card:${RUN}:${requestId}`,
      expect.stringContaining('saved as revision 3'),
      expect.any(String),
    );
  });

  it('writes nothing on Reject and tells the lead it was rejected', async () => {
    const { service, rowsOf, approvals, wakeLead, writeChange } = harness();
    await service.proposeProjectInstructions(RUN, CHANGE);
    const requestId = rowsOf('approval_request')[0]!.payload.id as string;

    approvals.resolve(RUN, requestId, false);
    await settle(wakeLead);

    expect(writeChange).not.toHaveBeenCalled();
    expect(rowsOf('approval_verdict')[0]!.payload).toEqual({
      id: requestId,
      nodeId: 'lead',
      allow: false,
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'lead',
      `card:${RUN}:${requestId}`,
      expect.stringContaining('rejected'),
      expect.any(String),
    );
  });

  it('raises no card on an archived team run', async () => {
    const { service, runs, rowsOf } = harness();
    runs.get(RUN)!.archivedAt = new Date();

    expect(await service.proposeProjectInstructions(RUN, CHANGE)).toEqual({
      status: 'unavailable',
      reason: 'this thread is archived, so the user cannot be asked',
    });
    expect(rowsOf('approval_request')).toEqual([]);
    expect(runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
    await expect(
      service.raiseOwnedCard(
        RUN,
        'req-1',
        { toolName: HOST_PROPOSE_TEAM_TOOL, input: {} },
        () => undefined,
      ),
    ).rejects.toMatchObject({ errorCode: 'RUN_ARCHIVED' });
  });

  it('tracks a standing card again at boot, so a press after a restart still writes', async () => {
    const { service, runs, approvals, writeChange, wakeLead } = harness();
    runs.get(RUN)!.pendingTeamProjectCard = serializeTeamProjectCard({
      kind: 'project',
      requestId: 'card-1',
      change: CHANGE,
    });

    await service.rehydrate();
    expect(approvals.resolve(RUN, 'card-1', true)).toBe(true);
    await settle(wakeLead);

    expect(writeChange).toHaveBeenCalledWith(RUN, CHANGE);
  });

  it('forgets at boot a card the transcript already closed, and closes one whose change no longer reads', async () => {
    const closedRun = harness();
    closedRun.runs.get(RUN)!.pendingTeamProjectCard = serializeTeamProjectCard({
      kind: 'project',
      requestId: 'card-1',
      change: CHANGE,
    });
    closedRun.rows.push({
      runId: RUN,
      memberId: 'lead',
      kind: 'approval_verdict',
      payload: { id: 'card-1', allow: true },
    });
    await closedRun.service.rehydrate();
    expect(closedRun.runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
    expect(closedRun.approvals.listByRun(RUN)).toEqual([]);

    const unreadable = harness();
    unreadable.runs.get(RUN)!.pendingTeamProjectCard = JSON.stringify({
      requestId: 'card-2',
      change: { projectId: '' },
    });
    await unreadable.service.rehydrate();
    expect(unreadable.runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
    expect(unreadable.rowsOf('unanswerable')).toEqual([
      expect.objectContaining({
        payload: { id: 'card-2', toolName: HOST_PROJECT_INSTRUCTIONS_TOOL },
      }),
    ]);
    expect(unreadable.approvals.listByRun(RUN)).toEqual([]);
  });
  it("installs itself as the executor's way to raise the lead's project card", async () => {
    const { service, useLeadProjectCards, rowsOf } = harness();
    service.onModuleInit();

    const propose = useLeadProjectCards.mock.calls[0]![0] as (
      runId: string,
      change: HostProjectInstructions,
    ) => Promise<HostProjectInstructionsOutcome>;
    expect(await propose(RUN, CHANGE)).toEqual(POSTED);
    expect(rowsOf('approval_request')).toHaveLength(1);
  });

  it('draws one card for two racing calls with the same change, and refuses a different one racing it', async () => {
    const { service, rowsOf } = harness();

    const [first, second, other] = await Promise.all([
      service.proposeProjectInstructions(RUN, CHANGE),
      service.proposeProjectInstructions(RUN, CHANGE),
      service.proposeProjectInstructions(RUN, {
        ...CHANGE,
        next: 'Other.',
        blocks: [{ id: 'repo', title: 'Repo', text: 'Other.' }],
      }),
    ]);

    expect(first).toEqual(POSTED);
    expect(second).toEqual(POSTED);
    expect(other).toEqual({
      status: 'unavailable',
      reason: QUESTION_ALREADY_STANDING,
    });
    expect(rowsOf('approval_request')).toHaveLength(1);
  });

  it('takes the card back when the run is archived while it is raised', async () => {
    const { service, runs, rowsOf, approvals, knobs } = harness();
    let checks = 0;
    knobs.archived = () => (checks += 1) > 1;

    expect(await service.proposeProjectInstructions(RUN, CHANGE)).toEqual({
      status: 'unavailable',
      reason: 'this thread is archived, so the user cannot be asked',
    });
    const requestId = rowsOf('approval_request')[0]!.payload.id;
    expect(rowsOf('unanswerable').map((row) => row.payload.id)).toEqual([
      requestId,
    ]);
    expect(approvals.listByRun(RUN)).toEqual([]);
    expect(runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
  });

  it('closes the column before it writes, and writes nothing when the column cannot be closed', async () => {
    let columnAtWrite: string | null | undefined;
    const ok = harness((runId) => {
      columnAtWrite = ok.runs.get(runId)!.pendingTeamProjectCard;
      return Promise.resolve({ status: 'saved', instructionsRevision: 3 });
    });
    await ok.service.proposeProjectInstructions(RUN, CHANGE);
    ok.approvals.resolve(
      RUN,
      ok.rowsOf('approval_request')[0]!.payload.id as string,
      true,
    );
    await settle(ok.wakeLead);
    expect(columnAtWrite).toBeNull();

    const stuck = harness();
    await stuck.service.proposeProjectInstructions(RUN, CHANGE);
    stuck.knobs.failColumnWrite = (value) => value === null;
    stuck.approvals.resolve(
      RUN,
      stuck.rowsOf('approval_request')[0]!.payload.id as string,
      true,
    );
    await settle(stuck.wakeLead);
    expect(stuck.writeChange).not.toHaveBeenCalled();
    expect(stuck.rowsOf('approval_verdict')[0]!.payload).toMatchObject({
      allow: true,
      outcome: 'not-saved',
      answer: 'the card could not be closed, so nothing was written',
    });
  });

  it("puts the lead's plugin card up, and its Approve writes the plugin and wakes the lead", async () => {
    const { service, runs, rowsOf, approvals, writePlugin, wakeLead } =
      harness();
    const proposal: HostPluginProposal = {
      slug: 'deploys',
      name: 'Deploys',
      text: 'name: Deploys\n',
      previousText: null,
      baseHash: null,
      command: 'gh run list --json name',
      folders: ['/repo'],
      refreshMinutes: 5,
      timeoutSeconds: 30,
      buttons: [],
      view: [{ id: 'root', component: 'Text', text: 'hi' }],
      sample: null,
    };

    expect(await service.proposePlugin(RUN, proposal)).toEqual(POSTED);
    const [request] = rowsOf('approval_request');
    expect(request!.payload).toMatchObject({ toolName: HOST_PLUGIN_TOOL });
    expect(runs.get(RUN)!.pendingTeamProjectCard).toContain('"kind":"plugin"');
    expect(await service.proposeProjectInstructions(RUN, CHANGE)).toMatchObject(
      { status: 'unavailable' },
    );

    approvals.resolve(RUN, request!.payload.id as string, true);
    await settle(wakeLead);

    expect(writePlugin).toHaveBeenCalledWith(proposal);
    expect(runs.get(RUN)!.pendingTeamProjectCard).toBeNull();
    expect(rowsOf('approval_verdict')[0]!.payload).toMatchObject({
      outcome: 'saved',
      answer: 'saved as deploys',
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'lead',
      expect.any(String),
      expect.stringContaining('/data/plugins/deploys.plugin.yaml'),
      expect.any(String),
    );
  });

  it('answers stale when the write itself fails', async () => {
    const { service, rowsOf, approvals, wakeLead } = harness(() =>
      Promise.reject(new Error('disk full')),
    );
    await service.proposeProjectInstructions(RUN, CHANGE);
    approvals.resolve(
      RUN,
      rowsOf('approval_request')[0]!.payload.id as string,
      true,
    );
    await settle(wakeLead);

    expect(rowsOf('approval_verdict')[0]!.payload).toMatchObject({
      outcome: 'not-saved',
      answer: 'the instructions could not be written',
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'lead',
      expect.any(String),
      expect.stringContaining('could not be saved'),
      expect.any(String),
    );
  });

  it("records a propose_team card's verdict in the lead's flow and wakes whoever leads with it", async () => {
    const { service, rowsOf, wakeLead } = harness();

    await service.deliverOwnedCardVerdict(
      RUN,
      'proposal-1',
      true,
      'The user approved the team change.',
      'looks good',
      { kind: 'saved', slug: 'team' },
    );

    expect(rowsOf('approval_verdict')).toEqual([
      expect.objectContaining({
        memberId: 'lead',
        payload: {
          id: 'proposal-1',
          nodeId: 'lead',
          allow: true,
          answer: 'looks good',
          outcome: { kind: 'saved', slug: 'team' },
        },
      }),
    ]);
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'lead',
      `card:${RUN}:proposal-1`,
      'The user approved the team change.',
      expect.any(String),
    );
  });
});

describe('TeamCardsService — a member’s own question', () => {
  const QUESTIONS = [
    { question: 'Which database?', options: [{ label: 'Postgres' }] },
  ];

  it('writes the pages a member’s deferred question passes', async () => {
    const { service, rowsOf, itemDao } = harness();
    await itemDao.create({
      runId: RUN,
      memberId: null,
      kind: 'show_artifact',
      payload: JSON.stringify({
        artifactId: 'plan-page',
        version: 1,
        title: 'Launch plan',
        key: 'k'.repeat(64),
      }),
    });

    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Storage', undefined, [
        'plan-page',
      ]),
    ).toEqual({ status: 'posted' });
    const [row] = rowsOf('approval_request');
    expect(row).toMatchObject({
      payload: {
        attachments: [
          {
            kind: 'artifact',
            artifactId: 'plan-page',
            title: 'Launch plan',
            version: 1,
          },
        ],
      },
    });
  });

  it('puts the card in the asking member’s flow, answers at once and keeps one per member', async () => {
    const { service, runs, rowsOf, approvals } = harness();

    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Storage'),
    ).toEqual({ status: 'posted' });
    const [row] = rowsOf('approval_request');
    expect(row).toMatchObject({
      memberId: 'worker',
      payload: {
        nodeId: 'worker',
        toolName: HOST_QUESTION_TOOL,
        input: { title: 'Storage', questions: QUESTIONS },
        questions: [{ question: 'Which database?' }],
      },
    });
    expect(approvals.listByRun(RUN)).toMatchObject([
      { memberId: 'worker', question: true, deferred: true, standing: true },
    ]);
    expect(runs.get(RUN)!.pendingMemberQuestions).toContain(
      row!.payload.id as string,
    );

    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Storage'),
    ).toEqual({ status: 'posted' });
    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Something else'),
    ).toEqual({ status: 'unavailable', reason: QUESTION_ALREADY_STANDING });
    expect(await service.askMember(RUN, 'other', QUESTIONS, null)).toEqual({
      status: 'posted',
    });
    expect(rowsOf('approval_request')).toHaveLength(2);
  });

  it('records the answer under the asker, takes the card out of the run and wakes that member with the user’s words', async () => {
    const { service, runs, rowsOf, approvals, wakeLead } = harness();
    await service.askMember(RUN, 'worker', QUESTIONS, null);
    const id = rowsOf('approval_request')[0]!.payload.id as string;

    expect(approvals.resolve(RUN, id, true, 'Postgres')).toBe(true);
    await settle(wakeLead);

    expect(runs.get(RUN)!.pendingMemberQuestions).toBeNull();
    expect(rowsOf('approval_verdict')[0]).toMatchObject({
      memberId: 'worker',
      payload: { id, nodeId: 'worker', allow: true, answer: 'Postgres' },
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'worker',
      `card:${RUN}:${id}`,
      'Postgres',
      expect.any(String),
    );
  });

  it('keeps a card already on screen under its own id, drawing no second card, and wakes the member with its answer', async () => {
    const { service, runs, rowsOf, approvals, wakeLead } = harness();
    const onScreen = 'run-1::node:worker#turn#card';

    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Storage', onScreen),
    ).toEqual({ status: 'posted' });
    expect(rowsOf('approval_request')).toEqual([]);
    expect(approvals.listByRun(RUN)).toMatchObject([
      { requestId: onScreen, memberId: 'worker', deferred: true },
    ]);
    expect(runs.get(RUN)!.pendingMemberQuestions).toContain(onScreen);

    expect(approvals.resolve(RUN, onScreen, true, 'Postgres')).toBe(true);
    await settle(wakeLead);
    expect(rowsOf('approval_verdict')[0]).toMatchObject({
      memberId: 'worker',
      payload: { id: onScreen, allow: true, answer: 'Postgres' },
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'worker',
      `card:${RUN}:${onScreen}`,
      'Postgres',
      expect.any(String),
    );
  });

  it('retires a card already on screen when another question of the member stands', async () => {
    const { service, rowsOf } = harness();
    await service.askMember(RUN, 'worker', QUESTIONS, 'Storage');

    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, 'Storage', 'on-screen'),
    ).toEqual({ status: 'unavailable', reason: QUESTION_ALREADY_STANDING });
    expect(rowsOf('unanswerable')).toMatchObject([
      { payload: { id: 'on-screen', toolName: HOST_QUESTION_TOOL } },
    ]);
  });

  it('closes every standing member question when the user writes instead of answering', async () => {
    const { service, runs, rowsOf, approvals } = harness();
    await service.askMember(RUN, 'worker', QUESTIONS, null);
    await service.askMember(RUN, 'other', QUESTIONS, null);

    await service.retireMemberQuestions(RUN);

    expect(approvals.listByRun(RUN)).toEqual([]);
    expect(runs.get(RUN)!.pendingMemberQuestions).toBeNull();
    expect(rowsOf('unanswerable').map((row) => row.payload.toolName)).toEqual([
      HOST_QUESTION_TOOL,
      HOST_QUESTION_TOOL,
    ]);
  });

  it('puts a standing member question back in the registry at boot, and closes one the transcript already answered', async () => {
    const first = harness();
    await first.service.askMember(RUN, 'worker', QUESTIONS, null);
    const column = first.runs.get(RUN)!.pendingMemberQuestions;

    const booted = harness();
    booted.runs.get(RUN)!.pendingMemberQuestions = column;
    await booted.service.rehydrate();
    expect(booted.approvals.listByRun(RUN)).toMatchObject([
      { memberId: 'worker', toolName: HOST_QUESTION_TOOL, deferred: true },
    ]);

    const answered = harness();
    answered.runs.get(RUN)!.pendingMemberQuestions = column;
    const id = first.rowsOf('approval_request')[0]!.payload.id as string;
    answered.rows.push({
      runId: RUN,
      memberId: 'worker',
      kind: 'approval_verdict',
      payload: { id },
    });
    await answered.service.rehydrate();
    expect(answered.approvals.listByRun(RUN)).toEqual([]);
    expect(answered.runs.get(RUN)!.pendingMemberQuestions).toBeNull();
  });

  it('draws one card for two identical asks racing in one tick', async () => {
    const { service, rowsOf } = harness();
    const [one, two] = await Promise.all([
      service.askMember(RUN, 'worker', QUESTIONS, null),
      service.askMember(RUN, 'worker', QUESTIONS, null),
    ]);
    expect([one, two]).toEqual([{ status: 'posted' }, { status: 'posted' }]);
    expect(rowsOf('approval_request')).toHaveLength(1);
  });

  it('records a Deny under the asker and wakes it with the dismissal', async () => {
    const { service, rowsOf, approvals, wakeLead } = harness();
    await service.askMember(RUN, 'worker', QUESTIONS, null);
    const id = rowsOf('approval_request')[0]!.payload.id as string;

    approvals.resolve(RUN, id, false);
    await settle(wakeLead);

    expect(rowsOf('approval_verdict')[0]!.payload).toEqual({
      id,
      nodeId: 'worker',
      allow: false,
    });
    expect(wakeLead).toHaveBeenCalledWith(
      RUN,
      'worker',
      `card:${RUN}:${id}`,
      expect.stringContaining('dismissed the question'),
      expect.any(String),
    );
  });

  it('never closes a card whose answer is being carried out when the user writes at the same moment', async () => {
    const { service, rowsOf, approvals, wakeLead } = harness();
    await service.askMember(RUN, 'worker', QUESTIONS, null);
    const id = rowsOf('approval_request')[0]!.payload.id as string;

    approvals.resolve(RUN, id, true, 'Postgres');
    await service.retireMemberQuestions(RUN);
    await settle(wakeLead);

    expect(rowsOf('unanswerable')).toEqual([]);
    expect(rowsOf('approval_verdict')).toHaveLength(1);
  });

  it('answers unavailable and leaves nothing standing when the card cannot be written', async () => {
    const { service, runs, approvals } = harness();
    const failing = service as unknown as {
      persist: (...args: unknown[]) => Promise<unknown>;
    };
    failing.persist = () => Promise.reject(new Error('SQLITE_BUSY'));
    expect(await service.askMember(RUN, 'worker', QUESTIONS, null)).toEqual({
      status: 'unavailable',
      reason: 'the question card could not be written',
      failure: 'internal',
    });
    expect(approvals.listByRun(RUN)).toEqual([]);
    expect(runs.get(RUN)!.pendingMemberQuestions).toBeNull();
  });

  it('refuses a card on an archived run', async () => {
    const { service, rowsOf, knobs } = harness();
    knobs.archived = () => true;
    expect(
      await service.askMember(RUN, 'worker', QUESTIONS, null),
    ).toMatchObject({ status: 'unavailable' });
    expect(rowsOf('approval_request')).toEqual([]);
  });
});
