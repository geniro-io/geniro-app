import { describe, expect, it } from 'vitest';

import type {
  HostWake,
  RunStatusEvent,
  StageProgress,
} from '../../agents/chat.types';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { Workflow } from '../graphs.types';
import type { GraphExecutorService } from './graph-executor.service';
import type { StageMoveResult, StageService } from './stage.service';
import { StageWakeService } from './stage-wake.service';

const WORKFLOW: Workflow = {
  name: 'w',
  nodes: [
    { id: 'trigger', kind: 'trigger', trigger: 'manual' },
    { id: 'lead', kind: 'agent', agent: 'claude', approval: 'auto' },
    { id: 'helper', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [
    { from: 'trigger', to: 'lead', kind: 'data' },
    { from: 'lead', to: 'helper', kind: 'call' },
  ],
  stages: [
    { id: 'build', title: 'Build', doneWhen: 'built', next: ['review'] },
    { id: 'review', title: 'Review', doneWhen: 'approved' },
  ],
};

const PROGRESS: StageProgress = {
  rev: 3,
  current: 'build',
  position: { index: 1, total: 2 },
  stages: [],
};

const REOPENED: Extract<StageMoveResult, { ok: true }> = {
  ok: true,
  workflow: WORKFLOW,
  stages: WORKFLOW.stages!,
  progress: PROGRESS,
  resets: ['review'],
  payload: {
    action: 'reopen',
    stageId: 'build',
    stageTitle: 'Build',
    text: 'the tests fail',
    rev: 3,
    by: { kind: 'user', via: 'desktop' },
  },
};

type Note = { action: 'nudge' | 'stalled'; stageId: string; rev: number };

function setUp(options: {
  result?: StageMoveResult;
  archived?: boolean;
  canWake?: boolean;
  continues?: boolean;
  progress?: StageProgress | null;
  waiting?: boolean;
  notes?: Note[];
  noteRefused?: boolean;
}): {
  service: StageWakeService;
  published: HostWake[];
  continued: { nodeId: string; text: string }[];
  moves: unknown[];
  notes: Note[];
  notified: RunStatusEvent[];
  settled: ((runId: string) => void)[];
  setCachedRev: (rev: number) => void;
} {
  let cachedRev = (options.progress ?? PROGRESS).rev;
  const notes: Note[] = [...(options.notes ?? [])];
  const notified: RunStatusEvent[] = [];
  const settled: ((runId: string) => void)[] = [];
  const published: HostWake[] = [];
  const continued: { nodeId: string; text: string }[] = [];
  const moves: unknown[] = [];
  const stages = {
    move: async (...args: unknown[]) => {
      moves.push(args);
      return (
        options.result ?? {
          ...REOPENED,
          payload: { ...REOPENED.payload, rev: 2 + moves.length },
        }
      );
    },
    current: async () =>
      options.progress === null
        ? null
        : {
            workflow: WORKFLOW,
            stages: WORKFLOW.stages!,
            progress: options.progress ?? PROGRESS,
          },
    cached: () => ({ progress: { ...PROGRESS, rev: cachedRev } }),
    isWaiting: async () => options.waiting === true,
    notesOf: async () => [...notes],
    note: async (
      _runId: string,
      action: 'nudge' | 'stalled',
      stage: { id: string },
      rev: number,
    ) => {
      if (options.noteRefused === true) {
        return false;
      }
      notes.push({ action, stageId: stage.id, rev });
      return true;
    },
  } as unknown as StageService;
  const executor = {
    canWake: () => options.canWake === true,
    onRunSettledCompleted: (listener: (runId: string) => void) => {
      settled.push(listener);
      return () => undefined;
    },
    continueAsHost: async (_runId: string, nodeId: string, text: string) => {
      continued.push({ nodeId, text });
      return options.continues === true;
    },
  } as unknown as GraphExecutorService;
  const bus = {
    publish: (wake: HostWake) => published.push(wake),
  } as unknown as HostWakeBus;
  return {
    service: new StageWakeService(stages, executor, bus, {
      publishRunStatus: (event: RunStatusEvent) => notified.push(event),
    } as unknown as AgentEventBus),
    published,
    continued,
    moves,
    notes,
    notified,
    settled,
    setCachedRev: (rev) => {
      cachedRev = rev;
    },
  };
}

const REQUEST = {
  action: 'reopen' as const,
  stage: 'build',
  text: 'the tests fail',
};

describe('StageWakeService.userMove', () => {
  it("wakes the lead in its own conversation with the move and the user's reason while a pass can reach it", async () => {
    const h = setUp({ canWake: true });
    const answer = await h.service.userMove('run-1', REQUEST, 'remote', 2);
    expect(answer).toEqual({ progress: PROGRESS, woke: true, hasLead: true });
    expect(h.moves[0]).toEqual([
      'run-1',
      REQUEST,
      { kind: 'user', via: 'remote' },
      { expectedRev: 2 },
    ]);
    expect(h.continued).toEqual([]);
    expect(h.published).toHaveLength(1);
    const [wake] = h.published;
    expect(wake!.owner).toEqual({
      runId: 'run-1',
      nodeId: 'lead',
      conversationId: null,
      caller: 'lead',
      target: 'workflow',
    });
    expect(wake!.prompt).toContain(
      'The user reopened the stage Build (back to pending: Review). Their reason: "the tests fail"',
    );
    expect(wake!.prompt).toContain('Now: Build (build) (1/2).');
    expect(wake!.note).toBe(wake!.prompt);
  });

  it('continues an idle run with no pass through the lead alone, and publishes nothing', async () => {
    const h = setUp({ canWake: false, continues: true });
    const answer = await h.service.userMove('run-1', REQUEST, 'desktop', 2);
    expect(answer.woke).toBe(true);
    expect(h.continued.map((c) => c.nodeId)).toEqual(['lead']);
    expect(h.published).toEqual([]);
  });

  it('falls back to the bus — a note owed to the next turn — when the run cannot be continued through the lead alone, and says the lead was not woken', async () => {
    const h = setUp({ canWake: false, continues: false });
    const answer = await h.service.userMove('run-1', REQUEST, 'desktop', 2);
    expect(answer.woke).toBe(false);
    expect(h.continued).toHaveLength(1);
    expect(h.published).toHaveLength(1);
  });

  it('says there is no lead to tell when the trigger starts no agent, and wakes nobody', async () => {
    const h = setUp({
      canWake: true,
      result: {
        ...REOPENED,
        workflow: {
          ...WORKFLOW,
          edges: [{ from: 'lead', to: 'helper', kind: 'call' }],
        },
      },
    });
    const answer = await h.service.userMove('run-1', REQUEST, 'desktop', 2);
    expect(answer).toEqual({ progress: PROGRESS, woke: false, hasLead: false });
    expect(h.published).toEqual([]);
    expect(h.continued).toEqual([]);
  });

  it('answers a stale revision 409 and any other refusal 400, waking nobody', async () => {
    const stale = setUp({
      result: { ok: false, code: 'STAGE_PROGRESS_CHANGED', message: 'moved' },
    });
    await expect(
      stale.service.userMove('run-1', REQUEST, 'desktop', 0),
    ).rejects.toMatchObject({
      errorCode: 'STAGE_PROGRESS_CHANGED',
      statusCode: 409,
    });
    const refused = setUp({
      result: { ok: false, code: 'NEXT_REQUIRED', message: 'name one' },
    });
    await expect(
      refused.service.userMove('run-1', REQUEST, 'desktop', 0),
    ).rejects.toMatchObject({ errorCode: 'NEXT_REQUIRED', statusCode: 400 });
    expect([...stale.published, ...refused.published]).toEqual([]);
  });

  it('answers an archived run 409 RUN_ARCHIVED, waking nobody', async () => {
    const h = setUp({
      result: { ok: false, code: 'RUN_ARCHIVED', message: 'archived' },
    });
    await expect(
      h.service.userMove('run-1', REQUEST, 'desktop', 0),
    ).rejects.toMatchObject({ errorCode: 'RUN_ARCHIVED', statusCode: 409 });
    expect(h.published).toEqual([]);
  });

  it('gives each move its own wake key, so two moves made while the lead works both reach it', async () => {
    const h = setUp({ canWake: true });
    await h.service.userMove('run-1', REQUEST, 'desktop', 2);
    await h.service.userMove('run-1', REQUEST, 'desktop', 3);
    expect(h.published.map((wake) => wake.key)).toEqual([
      'stage:run-1:3',
      'stage:run-1:4',
    ]);
  });
});

describe('StageWakeService.nudgeIfStalled', () => {
  it('nudges once per (stage, rev), then records stalled and notifies, then says nothing more', async () => {
    const h = setUp({ canWake: true });
    await h.service.nudgeIfStalled('run-1');
    expect(h.notes).toEqual([{ action: 'nudge', stageId: 'build', rev: 3 }]);
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.prompt).toContain(
      'Stage Build is still open: finish it with move_stage, skip it with a reason, or say what blocks it.',
    );
    expect(h.notified).toEqual([]);

    await h.service.nudgeIfStalled('run-1');
    expect(h.notes.map((n) => n.action)).toEqual(['nudge', 'stalled']);
    expect(h.published).toHaveLength(1);
    expect(h.notified).toEqual([
      {
        runId: 'run-1',
        status: null,
        notify:
          'Stage Build is still open after a nudge, and the agents have stopped.',
      },
    ]);

    await h.service.nudgeIfStalled('run-1');
    expect(h.notes).toHaveLength(2);
    expect(h.notified).toHaveLength(1);
  });

  it('drops a held nudge once a move changed the revision, so the lead never reads it beside the move that answered it', async () => {
    const h = setUp({ canWake: true });
    await h.service.nudgeIfStalled('run-1');
    const [nudge] = h.published;
    expect(nudge!.withdrawn?.()).toBe(false);
    h.setCachedRev(4);
    expect(nudge!.withdrawn?.()).toBe(true);
    await h.service.userMove('run-1', REQUEST, 'desktop', 3);
    expect(h.published[1]!.withdrawn).toBeUndefined();
  });

  it('wakes nobody when the nudge row was refused — the run was archived or deleted meanwhile', async () => {
    const h = setUp({ canWake: true, noteRefused: true });
    await h.service.nudgeIfStalled('run-1');
    expect(h.published).toEqual([]);
    expect(h.continued).toEqual([]);
  });

  it('nudges again once a move has changed the revision', async () => {
    const h = setUp({
      canWake: true,
      notes: [
        { action: 'nudge', stageId: 'build', rev: 2 },
        { action: 'stalled', stageId: 'build', rev: 2 },
      ],
    });
    await h.service.nudgeIfStalled('run-1');
    expect(h.notes.at(-1)).toEqual({
      action: 'nudge',
      stageId: 'build',
      rev: 3,
    });
    expect(h.published).toHaveLength(1);
  });

  it('says nothing for a finished walk, a workflow without stages, or a run that waits (archived, usage-limit reset)', async () => {
    const finished = setUp({
      canWake: true,
      progress: { ...PROGRESS, current: null },
    });
    const none = setUp({ canWake: true, progress: null });
    const waiting = setUp({ canWake: true, waiting: true });
    for (const h of [finished, none, waiting]) {
      await h.service.nudgeIfStalled('run-1');
      expect(h.notes).toEqual([]);
      expect(h.published).toEqual([]);
      expect(h.notified).toEqual([]);
    }
  });
});

describe('StageWakeService.onModuleInit', () => {
  it('checks a run for an open stage each time the executor says it settled completed', async () => {
    const h = setUp({ canWake: true });
    h.service.onModuleInit();
    expect(h.settled).toHaveLength(1);
    h.settled[0]!('run-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.notes).toEqual([{ action: 'nudge', stageId: 'build', rev: 3 }]);
  });
});
