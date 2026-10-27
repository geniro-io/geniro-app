import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  RunStatusEvent,
  RunWire,
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
import { STAGE_COLUMN_RETRY_MS, StageService } from './stage.service';

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
  failColumn: boolean;
  failRowsRead: boolean;
  runReads: number;
  deleted: Subject<string>;
  changed: Subject<RunWire[]>;
  fresh: () => StageService;
}

function setUp(
  stages: WorkflowStage[] | null = STAGES,
  options: {
    firstRowRead?: { entered: () => void; until: Promise<void> };
    archived?: boolean;
    deletedDuringRead?: boolean;
    resetWakes?: string | null;
    monitorRunning?: boolean;
    withLead?: boolean;
  } = {},
): Harness {
  const harness: Harness = {
    service: undefined as unknown as StageService,
    log: [],
    rows: [],
    run: { stageProgress: null, workflowId: 'dev-team' },
    announced: [],
    archive: async () => undefined,
    failColumn: false,
    failRowsRead: false,
    runReads: 0,
    deleted: new Subject<string>(),
    changed: new Subject<RunWire[]>(),
    fresh: () => undefined as unknown as StageService,
  };
  const workflow: Workflow = {
    name: 'w',
    nodes: [
      ...(options.withLead === true
        ? [
            {
              id: 'start',
              kind: 'trigger' as const,
              trigger: 'manual' as const,
            },
          ]
        : []),
      { id: 'lead', kind: 'agent', agent: 'claude', approval: 'auto' },
    ],
    edges:
      options.withLead === true
        ? [{ from: 'start', to: 'lead', kind: 'data' }]
        : [],
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
      if (harness.failRowsRead) {
        throw new Error('rows are unreadable');
      }
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
    getById: async () => {
      harness.runReads += 1;
      return deleted
        ? null
        : {
            id: 'run-1',
            ...harness.run,
            workflowSnapshot: null,
            archivedAt: archived ? new Date() : null,
            resetWakes: options.resetWakes ?? null,
          };
    },
    updateWithoutActivity: async (
      _id: string,
      data: { stageProgress: string },
    ) => {
      if (harness.failColumn) {
        throw new Error('the column is locked');
      }
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
    allDeleted: () => harness.deleted.asObservable(),
    allChanged: () => harness.changed.asObservable(),
  } as unknown as AgentEventBus;
  const runWorkflows = {
    workflowOf: async () => workflow,
  } as unknown as RunWorkflowService;
  const writes = new RunWriteQueue();
  const build = (): StageService =>
    new StageService(
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
  harness.service = build();
  harness.service.onModuleInit();
  harness.fresh = build;
  harness.archive = () =>
    writes.run('run-1', async () => {
      harness.log.push('archive');
      archived = true;
    });
  return harness;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('counts a move whose row is saved even when the column write fails, announcing and caching what the rows fold to', async () => {
    const error = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const h = setUp();
    h.failColumn = true;
    const result = await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    expect(result.ok && result.progress.rev).toBe(1);
    expect(result.ok && result.payload.rev).toBe(1);
    expect(h.rows).toHaveLength(1);
    expect(h.run.stageProgress).toBeNull();
    expect(h.service.cached('run-1')?.progress.rev).toBe(1);
    expect(h.announced.map((e) => e.stages?.rev)).toEqual([1]);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/run run-1:.*rev 1.*the column is locked/),
    );
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

  it('reads a workflow without stages once, then answers null without touching the run', async () => {
    const h = setUp(null);
    await h.service.current('run-1');
    const reads = h.runReads;
    expect(reads).toBeGreaterThan(0);
    expect(await h.service.current('run-1')).toBeNull();
    expect(h.runReads).toBe(reads);
  });

  it('answers null and logs when a dependency throws, caching nothing', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const h = setUp();
    h.failRowsRead = true;
    expect(await h.service.current('run-1')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /run run-1: could not read its stages.*rows are unreadable/,
      ),
    );
    expect(h.service.cached('run-1')).toBeNull();
    h.failRowsRead = false;
    expect((await h.service.current('run-1'))?.progress.current).toBe(
      'investigation',
    );
  });

  it('loads a staged run on a fresh instance with nothing registered, and leaves a current column alone', async () => {
    const h = setUp();
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    const column = h.run.stageProgress;
    const restarted = h.fresh();
    const loaded = await restarted.current('run-1');
    expect(loaded?.progress.current).toBe('fix');
    expect(loaded?.leadId).toBe(null);
    expect(restarted.canUse('run-1', 'lead')).toBe(false);
    expect(h.run.stageProgress).toBe(column);
    expect(h.announced).toHaveLength(1);
  });

  it('refolds the stage rows over a stale column on a cold read and stores what it folded', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    h.failColumn = false;
    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(0);
    const loaded = await h.fresh().current('run-1');
    expect(loaded?.progress.rev).toBe(1);
    expect(readRunStageProgress(h.run.stageProgress)).toEqual(loaded?.progress);
    expect(h.announced.at(-1)!.stages).toEqual(loaded?.progress);
  });

  it('repairs a column a failed write left behind on the next read of the same process', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    h.failColumn = false;

    const loaded = await h.service.current('run-1');

    expect(loaded?.progress.rev).toBe(1);
    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(1);
    expect(h.service.cached('run-1')?.progress.rev).toBe(1);
  });

  it('serves an archived run without caching it', async () => {
    const h = setUp(STAGES, { archived: true });
    expect((await h.service.current('run-1'))?.progress.current).toBe(
      'investigation',
    );
    expect(h.service.cached('run-1')).toBeNull();
  });
});

describe('StageService cache lifetime', () => {
  const MOVE = {
    action: 'complete' as const,
    stage: 'investigation',
    next: 'fix',
    text: 'x',
  };

  it('caches the run’s lead with its stages and progress', async () => {
    const h = setUp(STAGES, { withLead: true });
    await h.service.move('run-1', MOVE, AGENT);
    const cached = h.service.cached('run-1');
    expect(cached?.leadId).toBe('lead');
    expect(cached?.progress.current).toBe('fix');
    expect(cached?.stages.map((stage) => stage.id)).toEqual(
      STAGES.map((stage) => stage.id),
    );
  });

  it('drops a run from the cache when the run is deleted', async () => {
    const h = setUp();
    await h.service.move('run-1', MOVE, AGENT);
    h.deleted.next('other-run');
    expect(h.service.cached('run-1')).not.toBeNull();
    h.deleted.next('run-1');
    expect(h.service.cached('run-1')).toBeNull();
  });

  it('forgets that a run has no stages when the run is deleted', async () => {
    const h = setUp(null);
    await h.service.current('run-1');
    h.deleted.next('run-1');
    const reads = h.runReads;
    await h.service.current('run-1');
    expect(h.runReads).toBeGreaterThan(reads);
  });

  it('drops a run from the cache when it is archived, and keeps one that was merely re-filed', async () => {
    const h = setUp();
    await h.service.move('run-1', MOVE, AGENT);
    h.changed.next([{ id: 'run-1', archivedAt: null } as RunWire]);
    expect(h.service.cached('run-1')).not.toBeNull();
    h.changed.next([
      { id: 'run-1', archivedAt: '2026-01-01T00:00:00.000Z' } as RunWire,
    ]);
    expect(h.service.cached('run-1')).toBeNull();
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

  it('writes a nudge row that moves nothing, and says so', async () => {
    const h = setUp();
    await expect(
      h.service.note('run-1', 'nudge', STAGE, 0, 'still open'),
    ).resolves.toBe(true);
    expect(h.rows.map((row) => row.payload.action)).toEqual(['nudge']);
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

  it('writes nothing on an archived run, so no lead is woken about it', async () => {
    const h = setUp(STAGES, { archived: true });
    await expect(
      h.service.note('run-1', 'nudge', STAGE, 0, 'still open'),
    ).resolves.toBe(false);
    expect(h.rows).toEqual([]);
  });
});

describe('StageService column repair', () => {
  const MOVE = {
    action: 'complete' as const,
    stage: 'investigation',
    next: 'fix',
    text: 'x',
  };

  it('repairs a stale column before checking a user’s revision, so the announce tells the client the one to send', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move('run-1', MOVE, AGENT);
    h.failColumn = false;
    const restarted = h.fresh();
    h.announced.length = 0;

    const result = await restarted.move(
      'run-1',
      { action: 'complete', stage: 'fix', text: 'done' },
      { kind: 'user', via: 'desktop' },
      { expectedRev: 0 },
    );

    expect(result).toMatchObject({ ok: false, code: 'STAGE_PROGRESS_CHANGED' });
    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(1);
    expect(h.announced.map((event) => event.stages?.rev)).toEqual([1]);
  });

  it('keeps the newest revision readable after a failed column write, for a held nudge and a call reply', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move('run-1', MOVE, AGENT);

    expect(h.service.cached('run-1')?.progress.rev).toBe(1);
    expect(h.service.cached('run-1')?.progress.current).toBe('fix');
  });
});

describe('StageService while its column write fails', () => {
  const MOVE = {
    action: 'complete' as const,
    stage: 'investigation',
    next: 'fix',
    text: 'x',
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces a revision once, however often a read retries the write', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move('run-1', MOVE, AGENT);
    await h.service.current('run-1');
    await h.service.current('run-1');

    expect(h.announced.map((event) => event.stages?.rev)).toEqual([0, 1]);
  });

  it('writes the column on its own retry, with no read or move after the failure', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move('run-1', MOVE, AGENT);
    h.failColumn = false;
    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(0);

    await vi.advanceTimersByTimeAsync(STAGE_COLUMN_RETRY_MS);

    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(1);
  });

  it('stops retrying a run that was deleted', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.useFakeTimers();
    const h = setUp();
    await h.service.current('run-1');
    h.failColumn = true;
    await h.service.move('run-1', MOVE, AGENT);
    h.failColumn = false;
    h.deleted.next('run-1');

    await vi.advanceTimersByTimeAsync(STAGE_COLUMN_RETRY_MS);

    expect(readRunStageProgress(h.run.stageProgress)?.rev).toBe(0);
  });
});

describe('StageService generations', () => {
  it('moves a run to a new generation when it is archived or deleted', () => {
    const h = setUp();
    const start = h.service.generation('run-1');
    h.changed.next([
      { id: 'run-1', archivedAt: '2026-01-01T00:00:00.000Z' } as RunWire,
    ]);
    expect(h.service.generation('run-1')).toBe(start + 1);
    h.changed.next([{ id: 'run-1', archivedAt: null } as RunWire]);
    expect(h.service.generation('run-1')).toBe(start + 1);
  });

  it('leaves nothing cached for a run deleted while a move was in flight', async () => {
    let entered!: () => void;
    const inFirstRead = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setUp(STAGES, { firstRowRead: { entered, until } });
    const moving = h.service.move(
      'run-1',
      { action: 'complete', stage: 'investigation', next: 'fix', text: 'x' },
      AGENT,
    );
    await inFirstRead;
    h.deleted.next('run-1');
    release();
    await moving;
    await h.service.current('other-run');

    expect(h.service.cached('run-1')).toBeNull();
  });
});
