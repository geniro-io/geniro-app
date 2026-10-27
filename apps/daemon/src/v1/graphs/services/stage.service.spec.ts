import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type {
  RunStatusEvent,
  StageChangePayload,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import type { MonitorRegistry } from '../../agents/services/monitor.registry';
import { RunWriteQueue } from '../../agents/services/run-write.queue';
import { readRunStageProgress } from '../../agents/utils/stage-progress';
import type { Workflow, WorkflowStage } from '../graphs.types';
import type { RunWorkflowService } from './run-workflow.service';
import { StageService } from './stage.service';

const STAGES: WorkflowStage[] = [
  {
    id: 'investigation',
    title: 'Investigation',
    doneWhen: 'cause known',
    next: ['implementation', 'fix'],
  },
  {
    id: 'implementation',
    title: 'Implementation',
    doneWhen: 'built',
    next: ['review'],
  },
  { id: 'fix', title: 'Fix', doneWhen: 'fixed', next: ['review'] },
  { id: 'review', title: 'Review', doneWhen: 'approved' },
];

const AGENT = { kind: 'agent', nodeId: 'lead' } as const;

interface Harness {
  service: StageService;
  log: string[];
  rows: { seq: number; payload: StageChangePayload }[];
  run: { stageProgress: string | null; workflowId: string | null };
  announced: RunStatusEvent[];
  archive: () => Promise<void>;
}

function setUp(
  stages: WorkflowStage[] | null = STAGES,
  options: {
    firstRowRead?: { entered: () => void; until: Promise<void> };
    archived?: boolean;
    deletedDuringRead?: boolean;
    resetWakes?: string | null;
    monitorRunning?: boolean;
  } = {},
): Harness {
  const harness: Harness = {
    service: undefined as unknown as StageService,
    log: [],
    rows: [],
    run: { stageProgress: null, workflowId: 'dev-team' },
    announced: [],
    archive: async () => undefined,
  };
  const workflow: Workflow = {
    name: 'w',
    nodes: [{ id: 'lead', kind: 'agent', agent: 'claude', approval: 'auto' }],
    edges: [],
    ...(stages !== null ? { stages } : {}),
  };
  let seq = 0;
  let reads = 0;
  let archived = options.archived === true;
  let deleted = false;
  const em = {
    fork: () => em,
    clear: () => undefined,
  } as unknown as EntityManager;
  const itemDao = {
    stageChangeRows: async () => {
      reads += 1;
      if (options.deletedDuringRead === true) {
        deleted = true;
      }
      if (options.firstRowRead !== undefined && reads === 1) {
        options.firstRowRead.entered();
        await options.firstRowRead.until;
      }
      return harness.rows.map((row) => ({
        seq: row.seq,
        payload: JSON.stringify(row.payload),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, row.seq)),
      }));
    },
    create: async (data: { seq: number; payload: string }) => {
      harness.log.push('row');
      harness.rows.push({
        seq: data.seq,
        payload: JSON.parse(data.payload) as StageChangePayload,
      });
      return {
        id: `item-${data.seq}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, data.seq)),
      };
    },
  } as unknown as ItemDao;
  const runDao = {
    getById: async () =>
      deleted
        ? null
        : {
            id: 'run-1',
            ...harness.run,
            workflowSnapshot: null,
            archivedAt: archived ? new Date() : null,
            resetWakes: options.resetWakes ?? null,
          },
    updateWithoutActivity: async (
      _id: string,
      data: { stageProgress: string },
    ) => {
      harness.log.push('column');
      harness.run.stageProgress = data.stageProgress;
    },
  } as unknown as RunDao;
  const seqs = {
    reserve: async () => (seq += 1),
    settle: () => undefined,
  } as unknown as ItemSeqAllocator;
  const calls = {
    inCallOf: async () => '',
  } as unknown as ItemCallIndexService;
  const bus = {
    publish: () => undefined,
    publishRunStatus: (event: RunStatusEvent) => {
      if (event.stages !== undefined) {
        harness.log.push('run_status');
        harness.announced.push(event);
      }
    },
  } as unknown as AgentEventBus;
  const runWorkflows = {
    workflowOf: async () => workflow,
  } as unknown as RunWorkflowService;
  const writes = new RunWriteQueue();
  harness.service = new StageService(
    em,
    runDao,
    itemDao,
    seqs,
    calls,
    bus,
    runWorkflows,
    writes,
    {
      isRunning: () => options.monitorRunning === true,
    } as unknown as MonitorRegistry,
  );
  harness.archive = () =>
    writes.run('run-1', async () => {
      harness.log.push('archive');
      archived = true;
    });
  return harness;
}

describe('StageService.move', () => {
  it('writes row → column → run_status in order, and announces what the column holds', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      {
        action: 'complete',
        stage: 'investigation',
        next: 'fix',
        text: 'found it',
      },
      AGENT,
    );
    expect(result.ok).toBe(true);
    expect(h.log).toEqual(['row', 'column', 'run_status']);
    expect(h.rows[0]!.payload).toEqual({
      action: 'complete',
      stageId: 'investigation',
      stageTitle: 'Investigation',
      next: 'fix',
      text: 'found it',
      rev: 1,
      by: AGENT,
    });
    const stored = readRunStageProgress(h.run.stageProgress);
    expect(stored?.current).toBe('fix');
    expect(h.announced[0]!.stages).toEqual(stored);
  });

  it('refuses NEXT_REQUIRED at a fork, listing the branches', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', text: 'found it' },
      AGENT,
    );
    expect(result).toMatchObject({ ok: false, code: 'NEXT_REQUIRED' });
    expect(!result.ok && result.message).toContain('implementation, fix');
    expect(h.rows).toEqual([]);
  });

  it('refuses a stage that is not current, naming the current one', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'review', text: 'lgtm' },
      AGENT,
    );
    expect(result).toMatchObject({ ok: false, code: 'STAGE_NOT_CURRENT' });
    expect(!result.ok && result.message).toContain(
      'Investigation (investigation)',
    );
  });

  it('serializes two concurrent completes; the second gets STAGE_NOT_CURRENT', async () => {
    let entered!: () => void;
    const inFirstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setUp(STAGES, { firstRowRead: { entered, until } });
    const move = () =>
      h.service.move(
        'run-1',
        {
          action: 'complete',
          stage: 'investigation',
          next: 'implementation',
          text: 'done',
        },
        AGENT,
      );
    const both = Promise.all([move(), move()]);
    await inFirstRead;
    release();
    const [first, second] = await both;
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'STAGE_NOT_CURRENT' });
    expect(h.rows).toHaveLength(1);
  });

  it('refuses a stale expectedRev with STAGE_PROGRESS_CHANGED', async () => {
    const h = setUp();
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'a' },
      AGENT,
    );
    const result = await h.service.move(
      'run-1',
      { action: 'reopen', stage: 'investigation', text: 'not yet' },
      { kind: 'user', via: 'desktop' },
      { expectedRev: 0 },
    );
    expect(result).toMatchObject({ ok: false, code: 'STAGE_PROGRESS_CHANGED' });
  });

  it('reopens a finished stage, naming the stages it resets', async () => {
    const h = setUp();
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'a' },
      AGENT,
    );
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'fix', text: 'b' },
      AGENT,
    );
    const result = await h.service.move(
      'run-1',
      { action: 'reopen', stage: 'investigation', text: 'wrong cause' },
      { kind: 'user', via: 'remote' },
      { expectedRev: 2 },
    );
    expect(result.ok && result.resets).toEqual(['fix', 'review']);
    expect(result.ok && result.progress.current).toBe('investigation');
    expect(h.rows[2]!.payload.rev).toBe(3);
  });

  it('refuses reopening a stage that never finished, listing those that can', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      { action: 'reopen', stage: 'fix', text: 'x' },
      AGENT,
    );
    expect(result).toMatchObject({ ok: false, code: 'NOT_REOPENABLE' });
  });

  it('refuses an empty text, and more than three lines from an agent', async () => {
    const h = setUp();
    const blank = await h.service.move(
      'run-1',
      { action: 'skip', stage: 'investigation', next: 'fix', text: '  ' },
      AGENT,
    );
    expect(blank).toMatchObject({ ok: false, code: 'TEXT_REQUIRED' });
    const long = await h.service.move(
      'run-1',
      {
        action: 'skip',
        stage: 'investigation',
        next: 'fix',
        text: 'a\nb\nc\nd',
      },
      AGENT,
    );
    expect(long).toMatchObject({ ok: false, code: 'TEXT_TOO_LONG' });
  });

  it('refuses NO_STAGES for a workflow without stages', async () => {
    const h = setUp(null);
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', text: 'x' },
      AGENT,
    );
    expect(result).toMatchObject({ ok: false, code: 'NO_STAGES' });
  });

  it('works on an idle run with no pass registered — it needs no sink', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      {
        action: 'skip',
        stage: 'investigation',
        next: 'implementation',
        text: 'known bug',
      },
      { kind: 'user', via: 'desktop' },
    );
    expect(result.ok).toBe(true);
    expect(h.rows).toHaveLength(1);
  });
});

describe('StageService.current', () => {
  it('writes the starting progress once, keeps it, and follows a move', async () => {
    const h = setUp();
    expect((await h.service.current('run-1'))?.progress.current).toBe(
      'investigation',
    );
    expect(readRunStageProgress(h.run.stageProgress)?.current).toBe(
      'investigation',
    );
    expect(h.announced).toHaveLength(1);
    await h.service.current('run-1');
    expect(h.announced).toHaveLength(1);
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    expect(h.service.cached('run-1')?.progress.current).toBe('fix');
  });

  it('answers null for a workflow without stages', async () => {
    const h = setUp(null);
    expect(await h.service.current('run-1')).toBeNull();
    expect(h.run.stageProgress).toBeNull();
  });
});

describe('StageService.note', () => {
  it('writes a nudge row that moves nothing', async () => {
    const h = setUp();
    await h.service.note('run-1', 'nudge', STAGES[0]!, 0, 'still open');
    expect(await h.service.notesOf('run-1')).toEqual([
      { action: 'nudge', stageId: 'investigation', rev: 0 },
    ]);
    const after = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    expect(after.ok && after.payload.rev).toBe(1);
  });
});

describe('StageService.move — every refusal names its fix', () => {
  const AT_FIX = [
    {
      action: 'complete' as const,
      stage: 'investigation',
      next: 'fix',
      text: 'a',
    },
  ];
  it.each([
    {
      name: 'an unknown stage, listing the real ones',
      before: [],
      request: { action: 'complete' as const, stage: 'ghost', text: 'x' },
      code: 'STAGE_UNKNOWN',
      says: 'investigation, implementation, fix, review',
    },
    {
      name: 'a branch the fork does not offer',
      before: [],
      request: {
        action: 'complete' as const,
        stage: 'investigation',
        next: 'review',
        text: 'x',
      },
      code: 'NEXT_INVALID',
      says: 'ONE of: implementation, fix',
    },
    {
      name: 'a next on a stage that does not fork',
      before: AT_FIX,
      request: {
        action: 'complete' as const,
        stage: 'fix',
        next: 'implementation',
        text: 'x',
      },
      code: 'NEXT_INVALID',
      says: 'always followed by review',
    },
    {
      name: 'a move after every stage is done',
      before: [
        ...AT_FIX,
        { action: 'complete' as const, stage: 'fix', text: 'b' },
        { action: 'complete' as const, stage: 'review', text: 'c' },
      ],
      request: { action: 'skip' as const, stage: 'review', text: 'x' },
      code: 'STAGES_FINISHED',
      says: 'reopen one',
    },
    {
      name: 'a summary past the character cap',
      before: [],
      request: {
        action: 'complete' as const,
        stage: 'investigation',
        next: 'fix',
        text: 'x'.repeat(601),
      },
      code: 'TEXT_TOO_LONG',
      says: '600 characters',
    },
  ])('refuses $name', async ({ before, request, code, says }) => {
    const h = setUp();
    for (const move of before) {
      expect((await h.service.move('run-1', move, AGENT)).ok).toBe(true);
    }
    const result = await h.service.move('run-1', request, AGENT);
    expect(result).toMatchObject({ ok: false, code });
    expect(!result.ok && result.message).toContain(says);
  });

  it('holds only agents to three lines; the user may write more', async () => {
    const h = setUp();
    const result = await h.service.move(
      'run-1',
      {
        action: 'complete',
        stage: 'investigation',
        next: 'fix',
        text: 'a\nb\nc\nd',
      },
      { kind: 'user', via: 'desktop' },
    );
    expect(result.ok).toBe(true);
  });

  it('refuses any move on an archived run, writing nothing', async () => {
    const h = setUp(STAGES, { archived: true });
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      { kind: 'user', via: 'desktop' },
    );
    expect(result).toMatchObject({ ok: false, code: 'RUN_ARCHIVED' });
    expect(h.rows).toEqual([]);
  });

  it('writes nothing for a run deleted while its moves were read', async () => {
    const h = setUp(STAGES, { deletedDuringRead: true });
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    expect(result).toMatchObject({ ok: false });
    expect(h.rows).toEqual([]);
    expect(h.log).toEqual([]);
  });

  it('lets an archive pressed mid-move land only once the move is written, and refuses the move queued behind it', async () => {
    let entered!: () => void;
    const inFirstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setUp(STAGES, { firstRowRead: { entered, until } });
    const first = h.service.move(
      'run-1',
      {
        action: 'complete',
        stage: 'investigation',
        next: 'implementation',
        text: 'done',
      },
      AGENT,
    );
    await inFirstRead;
    const archived = h.archive();
    const second = h.service.move(
      'run-1',
      { action: 'complete', stage: 'implementation', text: 'built' },
      AGENT,
    );
    release();
    expect((await first).ok).toBe(true);
    await archived;
    expect(await second).toMatchObject({ ok: false, code: 'RUN_ARCHIVED' });
    expect(h.log).toEqual(['row', 'column', 'run_status', 'archive']);
    expect(h.rows).toHaveLength(1);
  });
});

describe('StageService.isWaiting', () => {
  const WAKE = JSON.stringify([
    {
      instant: 1,
      continuesAt: 2,
      resetsAt: '3pm',
      owners: [
        { owner: 'orch', calls: [{ callId: 'call-1', callee: 'helper' }] },
      ],
    },
  ]);

  it('is true for an archived run, a scheduled usage-limit continue and a running monitor', async () => {
    expect(
      await setUp(STAGES, { archived: true }).service.isWaiting('run-1'),
    ).toBe(true);
    expect(
      await setUp(STAGES, { resetWakes: WAKE }).service.isWaiting('run-1'),
    ).toBe(true);
    expect(
      await setUp(STAGES, { monitorRunning: true }).service.isWaiting('run-1'),
    ).toBe(true);
  });

  it('is false with none of those — an empty, unreadable or never-rearmable reset list included', async () => {
    for (const resetWakes of [null, '[]', '{bad', '[{"owners":[]}]']) {
      expect(
        await setUp(STAGES, { resetWakes }).service.isWaiting('run-1'),
      ).toBe(false);
    }
  });
});

describe('StageService.note', () => {
  const STAGE = STAGES[0]!;

  it('writes the nudge row and says so', async () => {
    const h = setUp();
    await expect(
      h.service.note('run-1', 'nudge', STAGE, 0, 'still open'),
    ).resolves.toBe(true);
    expect(h.rows.map((row) => row.payload.action)).toEqual(['nudge']);
  });

  it('writes nothing on an archived run, so no lead is woken about it', async () => {
    const h = setUp(STAGES, { archived: true });
    await expect(
      h.service.note('run-1', 'nudge', STAGE, 0, 'still open'),
    ).resolves.toBe(false);
    expect(h.rows).toEqual([]);
  });
});
