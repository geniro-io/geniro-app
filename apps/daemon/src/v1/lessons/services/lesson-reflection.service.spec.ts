import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EntityManager } from '@mikro-orm/sqlite';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { environment } from '../../../environments';
import type { RunStatusEvent } from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { DEFAULT_LESSONS_CONFIG, type LessonsConfig } from '../lessons.types';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

type Item = {
  seq: number;
  kind: string;
  role: string | null;
  payload: string;
};

const SNAPSHOT_SEQ = 9;

function userMessage(seq: number, text: string): Item {
  return {
    seq,
    kind: 'message',
    role: 'user',
    payload: JSON.stringify({ text }),
  };
}

function turnComplete(seq: number): Item {
  return { seq, kind: 'turn_complete', role: null, payload: '{}' };
}

function runOf(overrides: Partial<Run>): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    teamId: null,
    projectId: null,
    projectSource: 'none',
    cwd: null,
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

function build(
  options: {
    source?: Partial<Run>;
    maxSeq?: number;
    /** The newest row that is not a lessons row; defaults to `maxSeq`. */
    newestOwn?: number;
    /** The thread's open stretch, as `openOf` finds it. */
    open?: Record<string, unknown> | null;
    /** The stretch a press named, as `getById` finds it. */
    segment?: Record<string, unknown> | null;
    /** The stretch a reflection run belongs to, as `ofReflection` finds it. */
    reflectionSegment?: Record<string, unknown> | null;
    items?: Item[];
    running?: Partial<Run>[];
    project?: { id: string; folder: string } | null;
    config?: Omit<LessonsConfig, 'quietWindowHours'>;
    rejected?: { title: string; rejectReason: string | null }[];
    sendFails?: Error;
    createFails?: Error;
  } = {},
) {
  const source = runOf(options.source ?? {});
  const maxSeq = options.maxSeq ?? SNAPSHOT_SEQ;
  const items = options.items ?? [];
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn(() => Promise.resolve(source)),
    listLessonReflectionsOf: vi.fn(() =>
      Promise.resolve((options.running ?? []).map((run) => runOf(run))),
    ),
  };
  const itemDao = {
    maxSeq: vi.fn(() => Promise.resolve(maxSeq)),
    maxSeqExcept: vi.fn(() => Promise.resolve(options.newestOwn ?? maxSeq)),
    analysisPage: vi.fn(
      (
        _runId: string,
        page: {
          afterSeq: number;
          maxSeq: number;
          limit: number;
          kinds?: readonly string[];
        },
      ) =>
        Promise.resolve(
          items
            .filter(
              (item) =>
                item.seq > page.afterSeq &&
                item.seq <= page.maxSeq &&
                (page.kinds === undefined || page.kinds.includes(item.kind)),
            )
            .slice(0, page.limit),
        ),
    ),
  };
  const chats = {
    createChat: vi.fn((_input: Record<string, unknown>) =>
      options.createFails === undefined
        ? Promise.resolve({ id: 'refl-run' })
        : Promise.reject(options.createFails),
    ),
    sendMessage: vi.fn((_runId: string, _brief: string) =>
      options.sendFails === undefined
        ? Promise.resolve({})
        : Promise.reject(options.sendFails),
    ),
    delete: vi.fn((_runId: string) => Promise.resolve({ deleted: true })),
  };
  const segments = {
    create: vi.fn((input: Record<string, unknown>) =>
      Promise.resolve({ id: 'seg-1', ...input }),
    ),
    updateById: vi.fn(() => Promise.resolve()),
    deleteOfRuns: vi.fn((_runIds: readonly string[], _em: unknown) =>
      Promise.resolve(),
    ),
    openOf: vi.fn(() => Promise.resolve(options.open ?? null)),
    getById: vi.fn(() => Promise.resolve(options.segment ?? null)),
    ofReflection: vi.fn(() =>
      Promise.resolve(options.reflectionSegment ?? null),
    ),
  };
  const deleted = new Subject<string>();
  const statuses = new Subject<RunStatusEvent>();
  const proposals = {
    rejectedIn: vi.fn(() => Promise.resolve(options.rejected ?? [])),
  };
  const projectScope = {
    projectOfRun: vi.fn(() => Promise.resolve(options.project ?? null)),
  };
  const config = new LessonsConfigService();
  config.set({ ...DEFAULT_LESSONS_CONFIG, ...options.config });
  const events = new LessonsEventBus();
  const service = new LessonReflectionService(
    em,
    runDao as unknown as RunDao,
    itemDao as unknown as ItemDao,
    chats as unknown as ChatService,
    {
      allDeleted: () => deleted.asObservable(),
      allStatuses: () => statuses.asObservable(),
    } as unknown as AgentEventBus,
    { enabled: true } as MemoryService,
    projectScope as unknown as ProjectScopeService,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    config,
    events,
  );
  return {
    service,
    em,
    events,
    runDao,
    itemDao,
    chats,
    segments,
    proposals,
    projectScope,
    deleted,
    statuses,
  };
}

describe('LessonReflectionService.start', () => {
  let folder: string;

  beforeEach(() => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'lessons-')));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it.each([
    ['the watermark is the newest row', 9, 9],
    ['the thread holds fewer rows than the watermark', 9, 7],
  ])(
    'refuses a reflection when %s, starting no chat',
    async (_, reflectedThroughSeq, maxSeq) => {
      const fixture = build({
        source: { reflectedThroughSeq },
        maxSeq,
      });

      await expect(fixture.service.start('src', {})).rejects.toMatchObject({
        errorCode: 'LESSONS_NOTHING_NEW',
      });
      expect(fixture.chats.createChat).not.toHaveBeenCalled();
    },
  );

  it('refuses a second reflection while one on the thread is still working', async () => {
    const fixture = build({
      running: [{ id: 'r1', status: 'running' }],
    });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_REFLECTING',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('refuses a reflection whose only rows past the watermark are the lessons card and its outcomes', async () => {
    const { service, chats } = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ + 3,
      newestOwn: SNAPSHOT_SEQ,
    });

    await expect(service.start('src-run', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOTHING_NEW',
    });
    expect(chats.createChat).not.toHaveBeenCalled();
    expect((await service.state('src-run')).reflectable).toBe(false);
  });

  it('starts a new reflection once the earlier one has finished', async () => {
    const fixture = build({
      running: [{ id: 'r0', status: 'completed' }],
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an analysis', { analysisSourceRunId: 'other' }],
    ['a team analysis', { analysisTeamSlug: 'team-a' }],
    ['a team builder chat', { editsTeamSlug: 'team-a' }],
    ['a project chat', { editsProjectId: 'p1' }],
  ])('refuses to reflect on %s, starting no chat', async (_, source) => {
    const fixture = build({ source });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOT_REFLECTABLE',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('starts a hidden lessons chat on the thread and deletes nothing', async () => {
    const fixture = build({ source: { cwd: folder } });

    const started = await fixture.service.start('src', {});

    expect(started).toEqual({
      reflectionRunId: 'refl-run',
      segmentId: 'seg-1',
      fromSeq: -1,
      toSeq: SNAPSHOT_SEQ,
    });
    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude',
        cwd: folder,
        projectId: null,
        approval: 'ask',
        title: 'Lessons: Migrate the cache',
        taskInstructions: expect.stringContaining('# Lessons reflection'),
        analysisSource: {
          runId: 'src',
          seq: SNAPSHOT_SEQ,
          working: false,
          purpose: 'lessons',
        },
      }),
    );
    expect(fixture.segments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'src',
        fromSeq: -1,
        toSeq: SNAPSHOT_SEQ,
        closedBy: 'manual',
        status: 'reflecting',
      }),
      fixture.em,
    );
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { reflectionRunId: 'refl-run' },
      fixture.em,
    );
    expect(fixture.chats.delete).not.toHaveBeenCalled();
  });

  it('sends a brief that names the stretch, the signals found and the rejected lessons', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: 0 },
      maxSeq: 3,
      items: [
        turnComplete(1),
        userMessage(2, 'no, that is wrong'),
        userMessage(3, 'thanks'),
      ],
      rejected: [{ title: 'Old rule', rejectReason: 'too broad' }],
    });

    await fixture.service.start('src', {});

    const [runId, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(runId).toBe('refl-run');
    expect(brief).toContain('the items after seq 0 up to and including seq 3');
    expect(brief).toContain('- seq 2 · user_correction · "no, that is wrong"');
    expect(brief).toContain('- "Old rule" — reason: "too broad"');
  });

  it('tells the reflection that the daemon found no signal when a correction follows no finished turn', async () => {
    const fixture = build({
      items: [userMessage(2, 'no, that is wrong')],
    });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain('The daemon found no learning signal');
  });

  it('takes the agent, model and effort the input names over the settings', async () => {
    const fixture = build({
      config: {
        mode: 'offer',
        agentKind: 'claude',
        model: 'haiku',
        effort: 'low',
      },
    });

    await fixture.service.start('src', {
      agentKind: 'codex',
      model: 'gpt-5',
      effort: 'high',
    });

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'codex',
        model: 'gpt-5',
        effort: 'high',
      }),
    );
  });

  it('takes the model and effort from the settings when they name no agent', async () => {
    const fixture = build({
      config: { mode: 'offer', agentKind: null, model: 'haiku', effort: 'low' },
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude',
        model: 'haiku',
        effort: 'low',
      }),
    );
  });

  it('drops the settings’ model and effort when the input switches to another agent', async () => {
    const fixture = build({
      config: {
        mode: 'offer',
        agentKind: 'codex',
        model: 'o3',
        effort: 'high',
      },
    });

    await fixture.service.start('src', { agentKind: 'claude' });

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude' });
    expect(input.model).toBeUndefined();
    expect(input.effort).toBeUndefined();
  });

  it('keeps the thread’s config folder only for the agent that wrote it', async () => {
    const same = build({ source: { configDir: '/profiles/work' } });
    const other = build({ source: { configDir: '/profiles/work' } });

    await same.service.start('src', {});
    await other.service.start('src', { agentKind: 'codex' });

    expect(same.chats.createChat.mock.calls[0]![0]).toMatchObject({
      configDir: '/profiles/work',
    });
    expect(other.chats.createChat.mock.calls[0]![0].configDir).toBeUndefined();
  });

  it('runs in the thread’s own folder when it still exists', async () => {
    const fixture = build({ source: { cwd: folder } });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
      cwd: folder,
    });
  });

  it('falls back to the project folder when the thread’s folder is gone', async () => {
    const projectFolder = realpathSync(
      mkdtempSync(join(tmpdir(), 'lessons-project-')),
    );
    try {
      const fixture = build({
        source: { cwd: join(folder, 'gone'), projectId: 'p1' },
        project: { id: 'p1', folder: projectFolder },
      });

      await fixture.service.start('src', {});

      expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
        cwd: projectFolder,
        projectId: 'p1',
      });
    } finally {
      rmSync(projectFolder, { recursive: true, force: true });
    }
  });

  it('falls back to the app data folder when neither folder exists', async () => {
    const fixture = build({
      source: { cwd: join(folder, 'gone') },
      project: { id: 'p1', folder: join(folder, 'also-gone') },
    });

    await fixture.service.start('src', {});

    expect(fixture.chats.createChat.mock.calls[0]![0]).toMatchObject({
      cwd: environment.userDataDir,
    });
  });

  it('deletes the new chat and marks its segment failed when the brief cannot be sent', async () => {
    const fixture = build({ sendFails: new Error('boom') });

    await expect(fixture.service.start('src', {})).rejects.toThrow('boom');

    expect(fixture.chats.delete).toHaveBeenCalledWith('refl-run');
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'failed' },
      fixture.em,
    );
  });

  it('marks the segment failed and announces it when the chat cannot be created', async () => {
    const fixture = build({ createFails: new Error('no agent') });
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));

    await expect(fixture.service.start('src', {})).rejects.toThrow('no agent');

    expect(fixture.chats.sendMessage).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-1',
      { status: 'failed' },
      fixture.em,
    );
    expect(announced).toEqual(['src']);
  });

  it('announces the started reflection on its thread', async () => {
    const fixture = build();
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));

    await fixture.service.start('src', {});

    expect(announced).toEqual(['src']);
  });
});

describe('LessonReflectionService — review findings', () => {
  it('reads the signals of a stretch past its first page of 500 rows', async () => {
    const items = Array.from({ length: 520 }, (_, index) => index + 1).map(
      (seq) =>
        seq === 510 ? userMessage(510, 'no, that is wrong') : turnComplete(seq),
    );
    const fixture = build({ maxSeq: 520, items });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain(
      '- seq 510 · user_correction · "no, that is wrong"',
    );
  });

  it('finds a correction that opens a stretch after a reflected one, which starts on a finished turn', async () => {
    const fixture = build({
      source: { reflectedThroughSeq: 9 },
      maxSeq: 10,
      items: [userMessage(10, 'no, that is wrong')],
    });

    await fixture.service.start('src', {});

    const [, brief] = fixture.chats.sendMessage.mock.calls[0]!;
    expect(brief).toContain('- seq 10 · user_correction · "no, that is wrong"');
  });

  it('lets one of two simultaneous starts through and refuses the other as already reflecting', async () => {
    const fixture = build();

    const [first, second] = await Promise.allSettled([
      fixture.service.start('src', {}),
      fixture.service.start('src', {}),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second).toMatchObject({
      status: 'rejected',
      reason: { errorCode: 'LESSONS_REFLECTING' },
    });
    expect(fixture.chats.createChat).toHaveBeenCalledTimes(1);
  });

  it('falls back to the thread’s own agent when the settings name an agent this app does not know', async () => {
    const fixture = build({
      source: { agentKind: 'claude' },
      config: {
        mode: 'offer',
        agentKind: 'mystery-cli' as never,
        model: 'haiku',
        effort: 'low',
      },
    });

    await fixture.service.start('src', {});

    const input = fixture.chats.createChat.mock.calls[0]![0];
    expect(input).toMatchObject({ agentKind: 'claude' });
    expect(input.model).toBeUndefined();
    expect(input.effort).toBeUndefined();
  });

  it('drops the segments of a run when the run is deleted, and stops listening once destroyed', () => {
    const fixture = build();

    fixture.service.onModuleInit();
    fixture.deleted.next('run-gone');
    fixture.service.onModuleDestroy();
    fixture.deleted.next('run-later');

    expect(fixture.segments.deleteOfRuns).toHaveBeenCalledTimes(1);
    expect(fixture.segments.deleteOfRuns).toHaveBeenCalledWith(
      ['run-gone'],
      fixture.em,
    );
  });
});

describe('LessonReflectionService.state', () => {
  it('is reflectable only when something past the watermark exists', async () => {
    const nothing = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ,
    });
    const something = build({
      source: { reflectedThroughSeq: SNAPSHOT_SEQ },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await nothing.service.state('src')).toEqual({
      reflectable: false,
      reflectionRunId: null,
      reflectedThroughSeq: SNAPSHOT_SEQ,
    });
    expect(await something.service.state('src')).toEqual({
      reflectable: true,
      reflectionRunId: null,
      reflectedThroughSeq: SNAPSHOT_SEQ,
    });
  });

  it('is not reflectable while a reflection on the thread still runs, and names it', async () => {
    const fixture = build({
      maxSeq: SNAPSHOT_SEQ + 1,
      running: [{ id: 'r1', status: 'running' }],
    });

    expect(await fixture.service.state('src')).toMatchObject({
      reflectable: false,
      reflectionRunId: 'r1',
    });
  });

  it('is never reflectable for an analysis, whatever is past the watermark', async () => {
    const fixture = build({
      source: { analysisSourceRunId: 'other' },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await fixture.service.state('src')).toMatchObject({
      reflectable: false,
    });
  });

  it('is never reflectable on a thread being deleted, whatever is past the watermark', async () => {
    const fixture = build({
      source: { pendingDeleteAt: new Date() },
      maxSeq: SNAPSHOT_SEQ + 1,
    });

    expect(await fixture.service.state('src')).toEqual({
      reflectable: false,
      reflectionRunId: null,
      reflectedThroughSeq: null,
    });
  });
});

describe('LessonReflectionService.start on a waiting stretch', () => {
  const OPEN = {
    id: 'seg-open',
    runId: 'src',
    status: 'offered',
    attempts: 2,
    fromSeq: -1,
    toSeq: 4,
    closedBy: 'idle',
  };

  it('adopts the open stretch of the thread: no new row, one more attempt, reflecting', async () => {
    const fixture = build({ open: OPEN });

    const started = await fixture.service.start('src', {});

    expect(started.segmentId).toBe('seg-open');
    expect(fixture.segments.create).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-open',
      expect.objectContaining({
        status: 'reflecting',
        attempts: 3,
        reflectionRunId: null,
      }),
      fixture.em,
    );
    expect(fixture.segments.updateById).toHaveBeenCalledWith(
      'seg-open',
      { reflectionRunId: 'refl-run' },
      fixture.em,
    );
  });

  it('adopts the stretch a press named, without looking for the open one', async () => {
    const fixture = build({
      segment: { ...OPEN, id: 'seg-named', status: 'dismissed' },
    });

    const started = await fixture.service.start('src', {
      segmentId: 'seg-named',
    });

    expect(started.segmentId).toBe('seg-named');
    expect(fixture.segments.getById).toHaveBeenCalledWith(
      'seg-named',
      fixture.em,
    );
    expect(fixture.segments.openOf).not.toHaveBeenCalled();
    expect(fixture.segments.create).not.toHaveBeenCalled();
  });

  it.each(['reflected', 'reflecting', 'empty'])(
    'refuses a named stretch that is already %s, with 409 LESSON_SEGMENT_DECIDED',
    async (status) => {
      const fixture = build({ segment: { ...OPEN, status } });

      await expect(
        fixture.service.start('src', { segmentId: 'seg-open' }),
      ).rejects.toMatchObject({ errorCode: 'LESSON_SEGMENT_DECIDED' });
      expect(fixture.chats.createChat).not.toHaveBeenCalled();
    },
  );

  it('refuses a named stretch of another thread with 404 LESSON_SEGMENT_NOT_FOUND', async () => {
    const fixture = build({ segment: { ...OPEN, runId: 'other-thread' } });

    await expect(
      fixture.service.start('src', { segmentId: 'seg-open' }),
    ).rejects.toMatchObject({ errorCode: 'LESSON_SEGMENT_NOT_FOUND' });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('refuses a stretch id the thread does not have, with 404 LESSON_SEGMENT_NOT_FOUND', async () => {
    const fixture = build({ segment: null });

    await expect(
      fixture.service.start('src', { segmentId: 'missing' }),
    ).rejects.toMatchObject({ errorCode: 'LESSON_SEGMENT_NOT_FOUND' });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });
});

describe('LessonReflectionService: a reflection that ends without filing', () => {
  it('marks its stretch failed when its terminal status arrives while the stretch is still reflecting', async () => {
    const fixture = build({
      reflectionSegment: {
        id: 'seg-9',
        runId: 'src',
        status: 'reflecting',
      },
    });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });

    await vi.waitFor(() =>
      expect(fixture.segments.updateById).toHaveBeenCalledWith(
        'seg-9',
        { status: 'failed' },
        fixture.em,
      ),
    );
    fixture.service.onModuleDestroy();
  });

  it('announces the failed stretch on its thread', async () => {
    const fixture = build({
      reflectionSegment: {
        id: 'seg-9',
        runId: 'src',
        status: 'reflecting',
      },
    });
    const announced: (string | null)[] = [];
    fixture.events
      .allChanges()
      .subscribe((event) => announced.push(event.runId));
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });

    await vi.waitFor(() => expect(announced).toEqual(['src']));
    fixture.service.onModuleDestroy();
  });

  it('leaves a stretch that already filed its lessons alone', async () => {
    const fixture = build({
      reflectionSegment: {
        id: 'seg-9',
        runId: 'src',
        status: 'reflected',
      },
    });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'completed' });
    await vi.waitFor(() =>
      expect(fixture.segments.ofReflection).toHaveBeenCalledWith(
        'refl-9',
        fixture.em,
      ),
    );

    expect(fixture.segments.updateById).not.toHaveBeenCalled();
    fixture.service.onModuleDestroy();
  });

  it('leaves a reflection still running alone', async () => {
    const fixture = build({
      reflectionSegment: {
        id: 'seg-9',
        runId: 'src',
        status: 'reflecting',
      },
    });
    fixture.service.onModuleInit();

    fixture.statuses.next({ runId: 'refl-9', status: 'running' });

    expect(fixture.segments.ofReflection).not.toHaveBeenCalled();
    expect(fixture.segments.updateById).not.toHaveBeenCalled();
    fixture.service.onModuleDestroy();
  });
});

describe('LessonReflectionService.runningReflectionId', () => {
  it('names the reflection still working on the thread', async () => {
    const fixture = build({
      running: [{ id: 'r1', status: 'running' }],
    });

    await expect(fixture.service.runningReflectionId('src')).resolves.toBe(
      'r1',
    );
  });

  it('answers null once every reflection on the thread has finished', async () => {
    const fixture = build({
      running: [{ id: 'r0', status: 'completed' }],
    });

    await expect(
      fixture.service.runningReflectionId('src'),
    ).resolves.toBeNull();
  });
});

describe('LessonReflectionService.start on a thread being deleted', () => {
  const DELETING = { pendingDeleteAt: new Date() };

  it('refuses a reflection on it unless it is the delete that asked for one', async () => {
    const fixture = build({ source: DELETING });

    await expect(fixture.service.start('src', {})).rejects.toMatchObject({
      errorCode: 'LESSONS_NOT_REFLECTABLE',
    });
    expect(fixture.chats.createChat).not.toHaveBeenCalled();
  });

  it('starts the reflection of a delete that extracts lessons first', async () => {
    const fixture = build({ source: DELETING });

    const started = await fixture.service.start('src', {}, 'delete');

    expect(started.reflectionRunId).toBe('refl-run');
    expect(fixture.segments.create).toHaveBeenCalledWith(
      expect.objectContaining({ closedBy: 'delete', status: 'reflecting' }),
      fixture.em,
    );
  });
});
