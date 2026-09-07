import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import type { ChatService } from '../../agents/services/chat.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../../projects/projects.types';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { StartTaskRun } from '../tasks.types';
import { TASK_REPORT_INSTRUCTIONS } from '../utils/task-prompt';
import { TaskEventBus } from './task-events.bus';
import { TaskRunsService } from './task-runs.service';
import { TasksService } from './tasks.service';

/**
 * Real database and real DAOs, on `tasks.service.spec.ts`'s own reasoning: the
 * behaviour under test writes and re-reads the card, so a faked DAO would
 * answer whatever the test told it and the compare-and-set could never be
 * entered. `ChatService` is the one double — it needs the whole agent
 * substrate, and what this service asks of it is two calls.
 */
describe('TaskRunsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskRunsService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let em: EntityManager;
  let projectId: string;
  /**
   * Canonical, because `TasksService.update` puts `worktreePath` through
   * `resolveValidDirectory` — see the note in `tasks.service.spec.ts` for why
   * a raw `mkdtempSync` result fails this round-trip on macOS only.
   */
  let worktree: string;
  let createChat: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let deleteChat: ReturnType<typeof vi.fn>;

  /**
   * A complete run row on the wire.
   *
   * Annotated rather than cast, so a field the schema requires cannot go
   * missing here and still compile.
   */
  const runWire = (id: string): RunWire => ({
    id,
    status: 'pending',
    awaiting: null,
    holdingFor: 0,
    shellsOpen: 0,
    subagentsOut: 0,
    title: null,
    agentKind: 'claude',
    workflowId: null,
    cwd: worktree,
    startSha: null,
    startDirty: null,
    model: null,
    approval: null,
    effort: null,
    contextWindow: null,
    modelParameters: {},
    contextTokens: null,
    contextWindowTokens: null,
    workedMs: null,
    toolCalls: null,
    configDir: null,
    configDirPin: null,
    groupId: null,
    taskId: null,
    pinnedPosition: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    archivedAt: null,
    lastMessage: null,
    pullRequests: [],
    taskList: [],
  });

  const start = (over: Partial<StartTaskRun> = {}): StartTaskRun => ({
    cwd: worktree,
    branch: 'geniro/task-1',
    from: 'todo',
    ...over,
  });

  beforeAll(async () => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-task-run-')));
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task, Run],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
    rmSync(worktree, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    tasks = new TasksService(em, taskDao, projectDao, new TaskEventBus());
    // The fake writes a REAL run row, because the double-start guard asks the
    // run whether it has settled — against a stub it would find nothing and
    // wave every second start through.
    let runSeq = 0;
    createChat = vi.fn(async (input: { taskId?: string }) => {
      const id = `run-${(runSeq += 1)}`;
      await runDao.create({
        id,
        workflowId: null,
        status: 'running',
        agentKind: 'claude',
        cwd: worktree,
        taskId: input.taskId ?? null,
      });
      return runWire(id);
    });
    sendMessage = vi.fn(async () => undefined);
    deleteChat = vi.fn(async () => ({ deleted: true }));
    const chats = {
      createChat,
      sendMessage,
      delete: deleteChat,
    } as unknown as ChatService;
    service = new TaskRunsService(
      em,
      taskDao,
      projectDao,
      runDao,
      tasks,
      chats,
      new ProjectQueueService(em, projectDao, taskDao, runDao),
    );
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-runs-spec',
      agentKind: 'claude',
      groupId: 'group-7',
    });
    projectId = project.id;
  });

  const seed = async (over: { title?: string; description?: string } = {}) => {
    const task = await tasks.create({
      projectId,
      title: over.title ?? 'ship it',
      description: over.description,
    });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    return task;
  };

  it('records the run, its branch and its worktree on the card', async () => {
    const task = await seed();

    const started = await service.start(task.id, start());

    expect(started).toMatchObject({
      status: 'in_progress',
      runId: 'run-1',
      branch: 'geniro/task-1',
      worktreePath: worktree,
    });
    const stored = await taskDao.getById(task.id);
    expect(stored?.runId).toBe('run-1');
  });

  it('hands the chat the task id and the PROJECT’s group, not the folder rule', async () => {
    const task = await seed();

    await service.start(task.id, start());

    // The run works in a worktree — a path no sidebar group has ever claimed —
    // so resolving the group from the cwd would file every task run loose.
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'group-7' }),
    );
  });

  it('falls back to the project’s standing run configuration', async () => {
    const task = await seed();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'claude' }),
    );
  });

  it('sends the task’s title and description as the opening message', async () => {
    const task = await seed({
      title: 'Fix the cap',
      description: 'It is off by one.',
    });

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith(
      'run-1',
      'Fix the cap\n\nIt is off by one.',
    );
  });

  it('asks for a closing report AFTER the user’s own instructions', async () => {
    const task = await seed();

    await service.start(
      task.id,
      start({ customInstructions: 'Always use pnpm.' }),
    );

    const [passed] = createChat.mock.calls[0] as [
      { customInstructions: string },
    ];
    expect(passed.customInstructions).toBe(
      `Always use pnpm.\n\n${TASK_REPORT_INSTRUCTIONS}`,
    );
  });

  it('refuses a second start while the first run is still working', async () => {
    const task = await seed();
    await service.start(task.id, start());

    await expect(
      service.start(task.id, start({ from: 'in_progress' })),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already being worked'),
    });
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('refuses a card dragged out of in_progress while its agent works on', async () => {
    const task = await seed();
    await service.start(task.id, start());
    // Someone drags the card back by hand; the run it started is still live,
    // so the status alone can no longer answer whether a start is safe.
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'todo' });

    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('already being worked'),
    });
  });

  it('allows a re-run once the previous run has SETTLED', async () => {
    const task = await seed();
    await service.start(task.id, start());
    // Review sent it back. The card still names the run that did the work —
    // that is its history, not a claim on it.
    const finished = await runDao.getById('run-1');
    if (finished) {
      finished.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();

    await expect(service.start(task.id, start())).resolves.toMatchObject({
      status: 'in_progress',
    });
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('returns the card to where it was when the chat cannot be created', async () => {
    const task = await seed();
    createChat.mockRejectedValueOnce(new Error('no such agent'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'no such agent',
    );

    // The move is the reservation, so a start that fails must undo it — a card
    // left in `in_progress` with no run is one no board can start again.
    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
    expect(stored?.runId).toBeNull();
    expect(stored?.worktreePath).toBeNull();
  });

  it('returns the card when the opening message fails, keeping nothing half-started', async () => {
    const task = await seed();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
    expect(stored?.runId).toBeNull();
  });

  it('refuses when neither the request nor the project names an agent', async () => {
    const bare = await projectDao.create({
      name: 'No agent',
      folder: '/tmp/geniro-task-runs-bare',
    });
    const task = await tasks.create({ projectId: bare.id, title: 'orphan' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('names an agent to run'),
    });
    expect(createChat).not.toHaveBeenCalled();
  });

  it('refuses a SECOND start that arrives while the first is still in flight', async () => {
    const task = await seed();
    // `moveStatus` reads and then writes across an await, so two requests
    // arriving together can both find the card in `todo` and both pass it.
    // The synchronous claim is what closes that window, and losing the race
    // means two agents in two worktrees on one card.
    let release: (() => void) | undefined;
    createChat.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () => {
            resolve(runWire('run-1'));
          };
        }),
    );

    const first = service.start(task.id, start());
    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('already starting a run'),
    });

    // Release only once the first start has actually reached `createChat` —
    // it awaits the card read and the status move before it gets there.
    while (createChat.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release?.();
    await first.catch(() => undefined);
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  // ── The autopilot's own bounds ─────────────────────────────────────────────
  //
  // The queue route narrows its handout to the free slots, and that is a
  // convenience: nothing obliges a conductor to ask. These pin the refusal at
  // the place the run is actually made.

  const arm = async (patch: {
    cap?: number;
    streak?: number;
  }): Promise<void> => {
    const project = await projectDao.getById(projectId, em);
    if (patch.cap !== undefined) {
      (project as Project).autopilotMaxConcurrent = patch.cap;
    }
    if (patch.streak !== undefined) {
      (project as Project).autopilotFailureStreak = patch.streak;
    }
    await em.flush();
  };

  it('refuses an autopilot start once the project is at its cap', async () => {
    await arm({ cap: 1 });
    const working = await seed({ title: 'working' });
    await service.start(working.id, start());
    const next = await seed({ title: 'next' });

    await expect(
      service.start(next.id, { ...start(), startedBy: 'autopilot' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('is already running 1 of 1'),
    });
  });

  // The cap bounds a TIMER, not the person. Refusing them here would also mean
  // they could not run anything while the autopilot held every slot.
  it('lets a person start past the cap the autopilot is held to', async () => {
    await arm({ cap: 1 });
    const working = await seed({ title: 'working' });
    await service.start(working.id, start());
    const next = await seed({ title: 'next' });

    const started = await service.start(next.id, start());

    expect(started.status).toBe('in_progress');
  });

  it('refuses an autopilot start while the breaker is open', async () => {
    await arm({ streak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    const task = await seed();

    await expect(
      service.start(task.id, { ...start(), startedBy: 'autopilot' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('re-arm it'),
    });
  });

  // How a user checks that whatever broke is fixed, before re-arming.
  it('lets a person start while the breaker is open', async () => {
    await arm({ streak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    const task = await seed();

    const started = await service.start(task.id, start());

    expect(started.status).toBe('in_progress');
  });

  // The race neither the per-card claim nor the status compare-and-set can
  // see: two conductors picking two DIFFERENT cards, both counting a free
  // slot, both starting. Only serializing a project's starts closes it.
  it('keeps two simultaneous autopilot starts inside a cap of one', async () => {
    await arm({ cap: 1 });
    const first = await seed({ title: 'first' });
    const second = await seed({ title: 'second' });

    const settled = await Promise.allSettled([
      service.start(first.id, { ...start(), startedBy: 'autopilot' }),
      service.start(second.id, { ...start(), startedBy: 'autopilot' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(createChat).toHaveBeenCalledTimes(1);
    const inProgress = (await taskDao.listForProject(projectId)).filter(
      (task) => task.status === 'in_progress',
    );
    expect(inProgress).toHaveLength(1);
  });

  it('takes the run down with the card when a start fails after creating it', async () => {
    const task = await seed();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    // Otherwise the chat survives naming a card that no longer names it back,
    // with its working directory already pruned by the caller.
    expect(deleteChat).toHaveBeenCalledWith('run-1');
  });
});
