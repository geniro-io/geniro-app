import { ConflictException, NotFoundException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_START_THREAD_TOOL,
  type StartThreadAnswer,
  type StartThreadInput,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import type { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import type { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import type { TaskRunsService } from '../../tasks/services/task-runs.service';
import type { TasksService } from '../../tasks/services/tasks.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import {
  type RosterReason,
  START_FAILURE_MAX_CHARS,
} from '../command-center.types';
import { CommandCenterThreadStartDao } from '../dao/command-center-thread-start.dao';
import { CommandCenterThreadStart } from '../entity/command-center-thread-start.entity';
import type {
  CommandCenterChatService,
  RosterThread,
} from './command-center-chat.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterStartsService } from './command-center-starts.service';

const MANAGER = 'manager-1';
const AUTO_MANAGER = 'manager-auto';
const CHAT = 'chat-1';
const THREAD = 'thread-1';
const PROJECT_ID = 'project-1';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type Responder = (allow: boolean, answer?: string) => void;
type Wake = Parameters<HostWakeBus['publish']>[0];

function taskIdOf(answer: StartThreadAnswer): string {
  if (answer.status === 'refused') {
    throw new Error(`refused: ${answer.code}`);
  }
  if (!('taskId' in answer)) {
    throw new Error('started with no card');
  }
  return answer.taskId;
}

function input(over: Partial<StartThreadInput> = {}): StartThreadInput {
  return {
    project: 'Geniro',
    title: 'Billing cache',
    brief: 'Clear the cache',
    watch: false,
    card: true,
    ...over,
  };
}

describe('CommandCenterStartsService', () => {
  let db: Db;
  let taskDao: TaskDao;
  let service: CommandCenterStartsService;
  let createdIds: string[];
  let project: Project;

  let startProjectRun: ReturnType<
    typeof vi.fn<TaskRunsService['startProjectRun']>
  >;
  let agentEvents: AgentEventBus;
  let publishChanged: ReturnType<
    typeof vi.fn<CommandCenterEventBus['publishChanged']>
  >;
  let raiseOwnedCard: ReturnType<
    typeof vi.fn<
      (
        runId: string,
        requestId: string,
        card: { toolName: string; input: unknown },
        respond: Responder,
      ) => Promise<void>
    >
  >;
  let deliverOwnedCardVerdict: ReturnType<
    typeof vi.fn<
      (
        runId: string,
        requestId: string,
        allow: boolean,
        message: string,
        answer?: string,
      ) => Promise<void>
    >
  >;
  let trackOwnedCard: ReturnType<
    typeof vi.fn<
      (
        runId: string,
        requestId: string,
        card: { toolName: string; input: unknown },
        respond: Responder,
      ) => void
    >
  >;
  let wakePublish: ReturnType<typeof vi.fn<(wake: Wake) => void>>;
  let noticeInfo: ReturnType<
    typeof vi.fn<(runId: string, message: string) => Promise<void>>
  >;
  let addToRoster: ReturnType<
    typeof vi.fn<
      (
        managerRunId: string,
        threadRunIds: readonly string[],
        reason: RosterReason,
      ) => Promise<void>
    >
  >;
  let rosterThreads: ReturnType<
    typeof vi.fn<(managerRunId: string) => Promise<RosterThread[]>>
  >;
  let listAll: ReturnType<typeof vi.fn<() => Promise<Project[]>>>;
  let createTask: ReturnType<
    typeof vi.fn<(input: Partial<Task>) => Promise<Task>>
  >;
  let taskEvents: TaskEventBus;
  let announceInPlace: ReturnType<
    typeof vi.fn<(task: Pick<Task, 'id' | 'projectId' | 'status'>) => void>
  >;

  function announcedIds(): string[] {
    return announceInPlace.mock.calls.map(([task]) => task.id);
  }

  async function seedTask(extra: Partial<Task> = {}): Promise<Task> {
    const fork = db.em.fork();
    const task = Object.assign(new Task(), {
      projectId: PROJECT_ID,
      title: 'Billing cache',
      description: 'Clear the cache',
      status: 'backlog',
      number: 7,
      ...extra,
    } as Task);
    fork.persist(task);
    await fork.flush();
    return task;
  }

  async function taskOf(id: string): Promise<Task> {
    const task = await taskDao.getById(id, db.em.fork());
    if (task === null) {
      throw new Error(`task ${id} is missing`);
    }
    return task;
  }

  function startedEvent(taskId: string): void {
    taskEvents.publishTaskChanged({
      taskId,
      projectId: PROJECT_ID,
      status: 'in_progress',
    });
  }

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER, {
      commandCenter: true,
      approval: 'ask',
      title: 'Manager',
    });
    await db.seedRun(AUTO_MANAGER, {
      commandCenter: true,
      approval: 'auto',
      title: 'Manager (auto)',
    });
    await db.seedRun(CHAT, { approval: 'ask', title: 'Ordinary chat' });
    await db.seedRun(THREAD, { title: 'Billing cache' });
    taskDao = new TaskDao(db.em);
    createdIds = [];
    project = Object.assign(new Project(), {
      id: PROJECT_ID,
      name: 'Geniro',
      folder: '/work/geniro',
      taskKey: 'GEN',
    });

    raiseOwnedCard = vi.fn(() => Promise.resolve());
    deliverOwnedCardVerdict = vi.fn(() => Promise.resolve());
    trackOwnedCard =
      vi.fn<
        (
          runId: string,
          requestId: string,
          card: { toolName: string; input: unknown },
          respond: Responder,
        ) => void
      >();
    wakePublish = vi.fn<(wake: Wake) => void>();
    noticeInfo = vi.fn(() => Promise.resolve());
    addToRoster = vi.fn(() => Promise.resolve());
    rosterThreads = vi.fn(() => Promise.resolve([]));
    listAll = vi.fn(() => Promise.resolve([project]));
    createTask = vi.fn(async (fields: Partial<Task>) => {
      const task = await seedTask(fields);
      createdIds.push(task.id);
      return task;
    });
    taskEvents = new TaskEventBus();
    announceInPlace = vi.fn();
    startProjectRun = vi.fn(() => Promise.resolve({ runId: THREAD }));
    agentEvents = new AgentEventBus();
    publishChanged = vi.fn();

    service = new CommandCenterStartsService(
      db.em,
      new RunDao(db.em),
      new ItemDao(db.em),
      {
        raiseOwnedCard,
        deliverOwnedCardVerdict,
        trackOwnedCard,
      } as unknown as ChatService,
      { publish: wakePublish } as unknown as HostWakeBus,
      { listAll } as unknown as ProjectDao,
      taskDao,
      { create: createTask, announceInPlace } as unknown as TasksService,
      taskEvents,
      { addToRoster, rosterThreads } as unknown as CommandCenterChatService,
      { info: noticeInfo } as unknown as RunNoticeWriter,
      new CommandCenterThreadStartDao(db.em),
      { startProjectRun } as unknown as TaskRunsService,
      agentEvents,
      { publishChanged } as unknown as CommandCenterEventBus,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await db.orm.close(true);
  });

  describe('start', () => {
    it('starts an auto-approved card at once, with no Start card to answer', async () => {
      const answer = await service.start(AUTO_MANAGER, input());
      const taskId = taskIdOf(answer);

      expect(answer).toEqual({
        status: 'starting',
        taskId,
        identifier: 'GEN-7',
      });
      expect(raiseOwnedCard).not.toHaveBeenCalled();
      const task = await taskOf(taskId);
      expect(task.startApprovedAt).not.toBeNull();
      expect(task.startRequestedByRunId).toBe(AUTO_MANAGER);
      expect(announcedIds()).toEqual([taskId]);
    });

    it('keeps the manager’s note for the thread until the start is reported, then puts it on the roster', async () => {
      rosterThreads.mockResolvedValue([]);
      const answer = await service.start(
        AUTO_MANAGER,
        input({ note: '  watch billing  ' }),
      );
      const taskId = taskIdOf(answer);
      expect((await taskOf(taskId)).startRequestNote).toBe('watch billing');
      await taskDao.settleStartRequest(taskId);
      await taskDao.updateById(taskId, { runId: THREAD });

      startedEvent(taskId);

      await vi.waitFor(() =>
        expect(addToRoster).toHaveBeenCalledWith(
          AUTO_MANAGER,
          [THREAD],
          'manager',
          'watch billing',
          false,
        ),
      );
    });

    it('keeps the manager’s watch for the thread until the start is reported, then puts it on the roster watched', async () => {
      rosterThreads.mockResolvedValue([]);
      const answer = await service.start(AUTO_MANAGER, input({ watch: true }));
      const taskId = taskIdOf(answer);
      expect((await taskOf(taskId)).startRequestWatch).toBe(true);
      await taskDao.settleStartRequest(taskId);
      await taskDao.updateById(taskId, { runId: THREAD });

      startedEvent(taskId);

      await vi.waitFor(() =>
        expect(addToRoster).toHaveBeenCalledWith(
          AUTO_MANAGER,
          [THREAD],
          'manager',
          null,
          true,
        ),
      );
    });

    it('puts the Start card to the user in ask mode and leaves the card unapproved', async () => {
      const answer = await service.start(MANAGER, input());
      const taskId = taskIdOf(answer);

      expect(answer).toEqual({
        status: 'card_shown',
        taskId,
        identifier: 'GEN-7',
      });
      expect(raiseOwnedCard).toHaveBeenCalledTimes(1);
      const [runId, cardId, card] = raiseOwnedCard.mock.calls[0]!;
      expect(runId).toBe(MANAGER);
      expect(cardId).toContain(`command-center-start:${taskId}:`);
      expect(card).toEqual({
        toolName: HOST_START_THREAD_TOOL,
        input: {
          taskId,
          title: 'Billing cache',
          project: 'Geniro',
          brief: 'Clear the cache',
        },
      });
      const task = await taskOf(taskId);
      expect(task.startApprovedAt).toBeNull();
      expect(task.startRequestedByRunId).toBe(MANAGER);
      expect(task.status).toBe('backlog');
      expect(announcedIds()).toEqual([taskId]);
    });

    it('refuses CARD_NOT_SHOWN and clears the request when the Start card cannot be shown', async () => {
      raiseOwnedCard.mockRejectedValueOnce(new Error('no window'));

      const answer = await service.start(MANAGER, input());

      expect(answer).toEqual({
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        reason: expect.stringContaining('GEN-7'),
        failure: 'internal',
      });
      const task = await taskOf(createdIds[0]!);
      expect(task.startRequestedAt).toBeNull();
      expect(task.startRequestedByRunId).toBeNull();
      expect(task.status).toBe('backlog');
      expect(announcedIds()).toEqual([task.id, task.id]);
    });

    it('refuses a run that is not the command center manager, and files no card', async () => {
      expect(await service.start(CHAT, input())).toEqual({
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: expect.any(String),
      });
      expect(await service.start('missing-run', input())).toEqual({
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: expect.any(String),
      });
      expect(createTask).not.toHaveBeenCalled();
    });

    it('refuses an unknown project, and a name that two projects share', async () => {
      expect(
        await service.start(MANAGER, input({ project: 'Nowhere' })),
      ).toEqual({
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: expect.stringContaining('Nowhere'),
      });

      listAll.mockResolvedValueOnce([
        project,
        Object.assign(new Project(), {
          id: 'project-2',
          name: ' geniro ',
          folder: '/work/other',
          taskKey: 'OTH',
        }),
      ]);
      expect(
        await service.start(MANAGER, input({ project: 'GENIRO' })),
      ).toEqual({
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: expect.stringContaining('GENIRO'),
      });
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe("the user's verdict on the Start card", () => {
    it('approves the start and tells the manager when allowed, with the note', async () => {
      const taskId = taskIdOf(await service.start(MANAGER, input()));
      const cardId = raiseOwnedCard.mock.calls[0]![1];

      raiseOwnedCard.mock.calls[0]![3](true, 'go ahead');

      await vi.waitFor(() =>
        expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
          MANAGER,
          cardId,
          true,
          expect.stringContaining('approved starting "Billing cache"'),
          'go ahead',
        ),
      );
      expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
        MANAGER,
        cardId,
        true,
        expect.stringContaining("The user's note: go ahead"),
        'go ahead',
      );
      expect((await taskOf(taskId)).startApprovedAt).not.toBeNull();
      expect(announcedIds()).toEqual([taskId, taskId]);
    });

    it('clears the request, its watch and the requester, and leaves the card in backlog, when declined', async () => {
      const taskId = taskIdOf(
        await service.start(MANAGER, input({ watch: true })),
      );
      const cardId = raiseOwnedCard.mock.calls[0]![1];

      raiseOwnedCard.mock.calls[0]![3](false);

      await vi.waitFor(() =>
        expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
          MANAGER,
          cardId,
          false,
          expect.stringContaining('declined to start "Billing cache"'),
          undefined,
        ),
      );
      const task = await taskOf(taskId);
      expect(task.startRequestedAt).toBeNull();
      expect(task.startRequestedByRunId).toBeNull();
      expect(task.startApprovedAt).toBeNull();
      expect(task.startRequestWatch).toBe(false);
      expect(task.status).toBe('backlog');
      expect(announcedIds()).toEqual([taskId, taskId]);
    });
  });

  describe('the boot re-read of waiting Start cards', () => {
    it('clears and announces a request whose Start card was answered before the restart', async () => {
      const requestedAt = new Date(1_700_000_000_000);
      const task = await seedTask({
        startRequestedAt: requestedAt,
        startRequestedByRunId: MANAGER,
      });
      await db.seedItem(MANAGER, 1, new Date(), 'approval_verdict', {
        id: `command-center-start:${task.id}:${requestedAt.getTime()}`,
      });

      service.onApplicationBootstrap();

      await vi.waitFor(() => expect(announcedIds()).toEqual([task.id]));
      const after = await taskOf(task.id);
      expect(after.startRequestedAt).toBeNull();
      expect(after.startRequestedByRunId).toBeNull();
    });
  });

  describe('approvedStarts', () => {
    it('lists only approved starts not yet started, each with its folder, and drops one whose project is gone', async () => {
      const queued = await seedTask({
        title: 'First',
        startRequestedAt: new Date(1000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(1000),
      });
      const withFolder = await seedTask({
        title: 'Second',
        folder: '/work/custom',
        startRequestedAt: new Date(2000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(2000),
      });
      await seedTask({
        title: 'Waiting for the user',
        startRequestedAt: new Date(3000),
        startRequestedByRunId: MANAGER,
      });
      const started = await seedTask({
        title: 'Started',
        startRequestedAt: new Date(4000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(4000),
      });
      await taskDao.settleStartRequest(started.id);
      await seedTask({
        title: 'Orphan',
        projectId: 'project-gone',
        startRequestedAt: new Date(5000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(5000),
      });

      expect(await service.approvedStarts()).toEqual([
        {
          kind: 'card',
          taskId: queued.id,
          projectId: PROJECT_ID,
          title: 'First',
          status: 'backlog',
          folder: '/work/geniro',
          startedBy: 'manager',
        },
        {
          kind: 'card',
          taskId: withFolder.id,
          projectId: PROJECT_ID,
          title: 'Second',
          status: 'backlog',
          folder: '/work/custom',
          startedBy: 'manager',
        },
      ]);
    });
  });

  describe('failed', () => {
    it('clears the request and tells the manager once, with the reason cut to the limit', async () => {
      const task = await seedTask({
        startRequestedAt: new Date(),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(),
      });
      const reason = 'x'.repeat(START_FAILURE_MAX_CHARS + 50);

      await service.failed(task.id, reason);

      expect(wakePublish).toHaveBeenCalledTimes(1);
      expect(wakePublish).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `command-center:start-failed:${task.id}`,
          owner: expect.objectContaining({ runId: MANAGER }),
          prompt: expect.stringContaining(
            `could not be started: ${'x'.repeat(START_FAILURE_MAX_CHARS)}. The card stays`,
          ),
        }),
      );
      expect(wakePublish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'x'.repeat(START_FAILURE_MAX_CHARS + 1),
          ),
        }),
      );
      const after = await taskOf(task.id);
      expect(after.startRequestedAt).toBeNull();
      expect(after.startRequestedByRunId).toBeNull();
      expect(announcedIds()).toEqual([task.id]);
    });

    it('tells no one about a card that no manager is waiting on', async () => {
      const task = await seedTask({});

      await service.failed(task.id, 'boom');

      expect(wakePublish).not.toHaveBeenCalled();
    });
  });

  describe('the report of a started thread', () => {
    it('puts the thread on the manager roster and writes its Started row without waking the manager', async () => {
      const task = await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });

      startedEvent(task.id);

      await vi.waitFor(() => expect(noticeInfo).toHaveBeenCalledTimes(1));
      expect(addToRoster).toHaveBeenCalledWith(
        MANAGER,
        [THREAD],
        'manager',
        null,
        false,
      );
      expect(noticeInfo).toHaveBeenCalledWith(
        MANAGER,
        'Started "Billing cache"',
      );
      expect(wakePublish).not.toHaveBeenCalled();
      expect((await taskOf(task.id)).startRequestedByRunId).toBeNull();
    });

    it('tells the manager once when two reports of the same start race', async () => {
      await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });
      const reports = service as unknown as { reportStarted(): Promise<void> };

      await Promise.all([reports.reportStarted(), reports.reportStarted()]);

      expect(addToRoster).toHaveBeenCalledTimes(1);
      expect(noticeInfo).toHaveBeenCalledTimes(1);
    });

    it('gives the report back when telling the manager fails, so the next report tells it', async () => {
      const task = await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });
      addToRoster.mockRejectedValueOnce(new Error('roster locked'));

      startedEvent(task.id);

      await vi.waitFor(() => expect(addToRoster).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () =>
        expect((await taskOf(task.id)).startRequestedByRunId).toBe(MANAGER),
      );
      expect(noticeInfo).not.toHaveBeenCalled();

      startedEvent(task.id);

      await vi.waitFor(() => expect(noticeInfo).toHaveBeenCalledTimes(1));
      expect(addToRoster).toHaveBeenCalledTimes(2);
      expect(wakePublish).not.toHaveBeenCalled();
    });
  });

  describe('a start a system analysis asked for', () => {
    const ANALYSIS_RUN = 'analysis-1';

    it('lists it among the approved starts as the user’s, and a manager’s as the manager’s', async () => {
      const manager = await seedTask({
        number: 8,
        startRequestedAt: new Date(),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(),
        startRequestKind: 'manager',
      });
      const analysis = await seedTask({
        number: 9,
        startRequestedAt: new Date(),
        startRequestedByRunId: ANALYSIS_RUN,
        startApprovedAt: new Date(),
        startRequestKind: 'analysis',
      });

      const starts = await service.approvedStarts();

      expect(starts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: manager.id, startedBy: 'manager' }),
          expect.objectContaining({ taskId: analysis.id, startedBy: 'user' }),
        ]),
      );
    });

    it('never adds the started card to a manager roster, nor tells a manager of it', async () => {
      const task = await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: ANALYSIS_RUN,
        startRequestKind: 'analysis',
        runId: THREAD,
      });
      const reports = service as unknown as { reportStarted(): Promise<void> };

      await reports.reportStarted();

      expect(addToRoster).not.toHaveBeenCalled();
      expect(noticeInfo).not.toHaveBeenCalled();
      expect(wakePublish).not.toHaveBeenCalled();
      expect((await taskOf(task.id)).startRequestedByRunId).toBe(ANALYSIS_RUN);
    });

    it('publishes its failure for the analysis to report, and wakes no manager', async () => {
      const task = await seedTask({
        startRequestedAt: new Date(),
        startRequestedByRunId: ANALYSIS_RUN,
        startApprovedAt: new Date(),
        startRequestKind: 'analysis',
      });
      const failures: unknown[] = [];
      const subscription = taskEvents
        .startFailures()
        .subscribe((failure) => failures.push(failure));

      await service.failed(task.id, 'no agent on the project');
      subscription.unsubscribe();

      expect(failures).toEqual([
        {
          taskId: task.id,
          byRunId: ANALYSIS_RUN,
          title: 'Billing cache',
          reason: 'no agent on the project',
        },
      ]);
      expect(wakePublish).not.toHaveBeenCalled();
      expect((await taskOf(task.id)).startRequestedByRunId).toBeNull();
    });
  });

  describe('a start with no card', () => {
    type ThreadRequest = Parameters<CommandCenterThreadStartDao['create']>[0];

    const RUN_SETTINGS = {
      startSha: 'abc123',
      startDirty: false,
      customInstructions: 'Be brief.',
      replyLanguage: 'en',
    };

    const threads = () => new CommandCenterThreadStartDao(db.em);

    function cardId(startId: string): string {
      return `command-center-start:thread:${startId}`;
    }

    function requestOf(over: Partial<ThreadRequest> = {}): ThreadRequest {
      return {
        managerRunId: MANAGER,
        projectId: PROJECT_ID,
        title: 'Billing cache',
        brief: 'Clear the cache',
        agentKind: null,
        teamSlug: null,
        note: null,
        watch: false,
        requestedAt: new Date(),
        approvedAt: null,
        ...over,
      };
    }

    function seedRequest(over: Partial<ThreadRequest> = {}) {
      return threads().create(requestOf(over));
    }

    describe('start', () => {
      it('writes the request and raises its Start card in ask mode, filing no task', async () => {
        const answer = await service.start(MANAGER, input({ card: false }));
        const [row] = await threads().listWaiting(MANAGER);

        expect(answer).toEqual({ status: 'card_shown', startId: row!.id });
        expect(row).toMatchObject({
          title: 'Billing cache',
          brief: 'Clear the cache',
          projectId: PROJECT_ID,
          approvedAt: null,
        });
        expect(createTask).not.toHaveBeenCalled();
        expect(raiseOwnedCard).toHaveBeenCalledTimes(1);
        expect(raiseOwnedCard).toHaveBeenCalledWith(
          MANAGER,
          cardId(row!.id),
          {
            toolName: HOST_START_THREAD_TOOL,
            input: {
              startId: row!.id,
              title: 'Billing cache',
              project: 'Geniro',
              brief: 'Clear the cache',
            },
          },
          expect.any(Function),
        );
      });

      it('approves the request at once in auto mode, with no Start card', async () => {
        const answer = await service.start(
          AUTO_MANAGER,
          input({ card: false }),
        );
        const [row] = await threads().listApproved();

        expect(answer).toEqual({ status: 'starting', startId: row!.id });
        expect(row).toMatchObject({
          managerRunId: AUTO_MANAGER,
          approvedAt: expect.any(Date),
        });
        expect(raiseOwnedCard).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
      });

      it('marks the request failed and refuses CARD_NOT_SHOWN when its Start card cannot be shown', async () => {
        raiseOwnedCard.mockRejectedValueOnce(new Error('no window'));

        const answer = await service.start(MANAGER, input({ card: false }));
        const [row] = await db.em
          .fork()
          .find(CommandCenterThreadStart, { managerRunId: MANAGER });

        expect(answer).toEqual({
          status: 'refused',
          code: 'CARD_NOT_SHOWN',
          reason: expect.any(String),
          failure: 'internal',
        });
        expect(row).toMatchObject({
          runId: null,
          failedAt: expect.any(Date),
          failure: 'its Start card could not be shown',
        });
        expect(createTask).not.toHaveBeenCalled();
      });
    });

    describe("the user's verdict on it", () => {
      it('approves the request and tells the manager, carrying the note', async () => {
        await service.start(MANAGER, input({ card: false }));
        const [row] = await threads().listWaiting(MANAGER);

        raiseOwnedCard.mock.calls[0]![3](true, 'go ahead');

        await vi.waitFor(() =>
          expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
            MANAGER,
            cardId(row!.id),
            true,
            expect.stringMatching(
              /approved starting "Billing cache".*The user's note: go ahead/s,
            ),
            'go ahead',
          ),
        );
        expect(await threads().read(row!.id)).toMatchObject({
          approvedAt: expect.any(Date),
          declinedAt: null,
        });
      });

      it('declines the request and tells the manager that nothing started', async () => {
        await service.start(MANAGER, input({ card: false }));
        const [row] = await threads().listWaiting(MANAGER);

        raiseOwnedCard.mock.calls[0]![3](false);

        await vi.waitFor(() =>
          expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
            MANAGER,
            cardId(row!.id),
            false,
            expect.stringContaining(
              'The user declined to start "Billing cache". Nothing was started.',
            ),
            undefined,
          ),
        );
        expect(await threads().read(row!.id)).toMatchObject({
          approvedAt: null,
          declinedAt: expect.any(Date),
        });
      });

      it('answers a second Start card with no change, carrying nothing', async () => {
        await service.start(MANAGER, input({ card: false }));
        const [row] = await threads().listWaiting(MANAGER);
        const respond = raiseOwnedCard.mock.calls[0]![3];

        respond(true);
        await vi.waitFor(() =>
          expect(deliverOwnedCardVerdict).toHaveBeenCalledTimes(1),
        );
        respond(false, 'changed my mind');

        await vi.waitFor(() =>
          expect(deliverOwnedCardVerdict).toHaveBeenCalledTimes(2),
        );
        expect(deliverOwnedCardVerdict).toHaveBeenLastCalledWith(
          MANAGER,
          cardId(row!.id),
          false,
          expect.stringContaining('no longer asks to start'),
          'changed my mind',
        );
        expect(await threads().read(row!.id)).toMatchObject({
          approvedAt: expect.any(Date),
          declinedAt: null,
        });
      });
    });

    describe('approvedStarts', () => {
      it('lists an approved request not yet claimed beside card starts, and drops one whose project is gone', async () => {
        const queued = await seedRequest({
          title: 'Queued thread',
          approvedAt: new Date(),
        });
        await seedRequest({ title: 'Waiting thread' });
        await seedRequest({
          title: 'Gone project',
          projectId: 'project-gone',
          approvedAt: new Date(),
        });
        const claimed = await seedRequest({
          title: 'Claimed thread',
          approvedAt: new Date(),
        });
        await threads().claim(claimed.id, new Date());
        const card = await seedTask({
          title: 'Card start',
          startRequestedAt: new Date(),
          startRequestedByRunId: MANAGER,
          startApprovedAt: new Date(),
        });

        const starts = await service.approvedStarts();

        expect(starts).toHaveLength(2);
        expect(starts).toEqual(
          expect.arrayContaining([
            {
              kind: 'card',
              taskId: card.id,
              projectId: PROJECT_ID,
              title: 'Card start',
              status: 'backlog',
              folder: '/work/geniro',
              startedBy: 'manager',
            },
            {
              kind: 'thread',
              startId: queued.id,
              projectId: PROJECT_ID,
              title: 'Queued thread',
              folder: '/work/geniro',
              startedBy: 'manager',
            },
          ]),
        );
      });
    });

    describe('startThreadRun', () => {
      it('starts the thread in the project, rosters it with its note and watch, and tells the manager once', async () => {
        const row = await seedRequest({
          agentKind: 'claude',
          note: 'watch billing',
          watch: true,
          approvedAt: new Date(),
        });

        const state = await service.startThreadRun(row.id, RUN_SETTINGS);

        expect(startProjectRun).toHaveBeenCalledTimes(1);
        expect(startProjectRun).toHaveBeenCalledWith({
          ...RUN_SETTINGS,
          projectId: PROJECT_ID,
          title: 'Billing cache',
          prompt: 'Clear the cache',
          target: { agentKind: 'claude', teamSlug: null },
          startedBy: 'manager',
        });
        expect(state).toEqual({
          startId: row.id,
          state: 'started',
          runId: THREAD,
          failure: null,
        });
        expect(addToRoster).toHaveBeenCalledWith(
          MANAGER,
          [THREAD],
          'manager',
          'watch billing',
          true,
        );
        expect(noticeInfo).toHaveBeenCalledTimes(1);
        expect(noticeInfo).toHaveBeenCalledWith(
          MANAGER,
          'Started "Billing cache"',
        );
        expect(await threads().read(row.id)).toMatchObject({
          runId: THREAD,
          reportedAt: expect.any(Date),
        });
      });

      it('refuses a second start of the same request as START_TAKEN', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        await service.startThreadRun(row.id, RUN_SETTINGS);

        await expect(
          service.startThreadRun(row.id, RUN_SETTINGS),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          service.startThreadRun(row.id, RUN_SETTINGS),
        ).rejects.toMatchObject({ errorCode: 'START_TAKEN' });
        expect(startProjectRun).toHaveBeenCalledTimes(1);
      });

      it('releases the claim and rethrows when the run cannot start, so the request is listed again', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        startProjectRun.mockRejectedValueOnce(new Error('no such folder'));

        await expect(
          service.startThreadRun(row.id, RUN_SETTINGS),
        ).rejects.toThrow('no such folder');

        expect(addToRoster).not.toHaveBeenCalled();
        expect(noticeInfo).not.toHaveBeenCalled();
        expect(await service.approvedStarts()).toEqual([
          expect.objectContaining({ kind: 'thread', startId: row.id }),
        ]);
      });
    });

    describe('failed', () => {
      it('fails the request with its reason cut to the limit, and wakes the manager once', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        const reason = 'x'.repeat(START_FAILURE_MAX_CHARS + 50);

        await service.failed(row.id, reason);

        expect(wakePublish).toHaveBeenCalledTimes(1);
        expect(wakePublish).toHaveBeenCalledWith(
          expect.objectContaining({
            key: `command-center:start-failed:${row.id}`,
            owner: expect.objectContaining({ runId: MANAGER }),
            prompt: expect.stringContaining(
              `could not be started: ${'x'.repeat(START_FAILURE_MAX_CHARS)}. Nothing was started`,
            ),
          }),
        );
        expect(await service.threadStartState(row.id)).toEqual({
          startId: row.id,
          state: 'failed',
          runId: null,
          failure: 'x'.repeat(START_FAILURE_MAX_CHARS),
        });
      });

      it('leaves a request that already started alone, and tells the manager nothing', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        await threads().recordRun(row.id, THREAD);

        await service.failed(row.id, 'too late');

        expect(wakePublish).not.toHaveBeenCalled();
        expect(await service.threadStartState(row.id)).toMatchObject({
          state: 'started',
          failure: null,
        });
      });
    });

    describe('threadStartState', () => {
      it('answers where each request stands, and refuses an unknown one', async () => {
        const waiting = await seedRequest({ title: 'Waiting' });
        const approved = await seedRequest({
          title: 'Approved',
          approvedAt: new Date(),
        });
        const started = await seedRequest({
          title: 'Started',
          approvedAt: new Date(),
        });
        const declined = await seedRequest({ title: 'Declined' });
        const failed = await seedRequest({ title: 'Failed' });
        await threads().recordRun(started.id, THREAD);
        await threads().decline(declined.id, new Date());
        await threads().fail(failed.id, new Date(), 'boom');

        const states = await Promise.all(
          [waiting, approved, started, declined, failed].map(
            async (row) => (await service.threadStartState(row.id)).state,
          ),
        );

        expect(states).toEqual([
          'waiting',
          'approved',
          'started',
          'declined',
          'failed',
        ]);
        await expect(
          service.threadStartState('no-such-start'),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    describe('the boot re-read', () => {
      it('tracks a waiting Start card again under its own id', async () => {
        const row = await seedRequest();

        service.onApplicationBootstrap();

        await vi.waitFor(() =>
          expect(trackOwnedCard).toHaveBeenCalledWith(
            MANAGER,
            cardId(row.id),
            {
              toolName: HOST_START_THREAD_TOOL,
              input: {
                startId: row.id,
                title: 'Billing cache',
                project: 'Geniro',
                brief: 'Clear the cache',
              },
            },
            expect.any(Function),
          ),
        );
      });

      it('fails a waiting request whose Start card already holds a verdict', async () => {
        const row = await seedRequest();
        await db.seedItem(MANAGER, 1, new Date(), 'approval_verdict', {
          id: cardId(row.id),
        });

        service.onApplicationBootstrap();

        await vi.waitFor(async () =>
          expect((await service.threadStartState(row.id)).state).toBe('failed'),
        );
        expect(await service.threadStartState(row.id)).toMatchObject({
          failure: 'its Start card was closed before it was answered',
        });
        expect(trackOwnedCard).not.toHaveBeenCalled();
      });

      it('fails a request a drain claimed but never started, and wakes the manager', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        await threads().claim(row.id, new Date());

        service.onApplicationBootstrap();

        await vi.waitFor(async () =>
          expect(await service.threadStartState(row.id)).toMatchObject({
            state: 'failed',
            failure: 'the app stopped while it was being started',
          }),
        );
        expect(wakePublish).toHaveBeenCalledTimes(1);
      });

      it('leaves a claimed request that recorded its run alone', async () => {
        const row = await seedRequest({ approvedAt: new Date() });
        await threads().claim(row.id, new Date());
        await threads().recordRun(row.id, THREAD);

        service.onApplicationBootstrap();

        await vi.waitFor(() =>
          expect(noticeInfo).toHaveBeenCalledWith(
            MANAGER,
            'Started "Billing cache"',
          ),
        );
        expect((await service.threadStartState(row.id)).state).toBe('started');
        expect(wakePublish).not.toHaveBeenCalled();
      });

      it('reports a started request the manager was not told of', async () => {
        const row = await seedRequest({
          note: 'watch billing',
          watch: true,
          approvedAt: new Date(),
        });
        await threads().recordRun(row.id, THREAD);

        service.onApplicationBootstrap();

        await vi.waitFor(() =>
          expect(noticeInfo).toHaveBeenCalledWith(
            MANAGER,
            'Started "Billing cache"',
          ),
        );
        expect(addToRoster).toHaveBeenCalledWith(
          MANAGER,
          [THREAD],
          'manager',
          'watch billing',
          true,
        );
        expect(await threads().read(row.id)).toMatchObject({
          reportedAt: expect.any(Date),
        });
      });
    });

    describe("the manager's deletion", () => {
      it('drops its cardless requests and keeps another manager’s', async () => {
        const mine = await seedRequest({ managerRunId: MANAGER });
        const theirs = await seedRequest({ managerRunId: AUTO_MANAGER });

        agentEvents.publishRunDeleted(MANAGER);

        await vi.waitFor(async () =>
          expect(await threads().read(mine.id)).toBeNull(),
        );
        expect(await threads().read(theirs.id)).not.toBeNull();
      });
    });
  });
});
