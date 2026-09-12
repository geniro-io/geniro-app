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
import type { RunGroupsService } from '../../agents/services/run-groups.service';
import type { GraphExecutorService } from '../../graphs/services/graph-executor.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../../projects/projects.types';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { StartTaskRun } from '../tasks.types';
import {
  AUTOPILOT_APPROVAL,
  RUN_TARGET_PROBLEM_CODE,
} from '../utils/run-target';
import { TASK_REPORT_INSTRUCTIONS } from '../utils/task-prompt';
import { TaskAttachmentService } from './task-attachment.service';
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
/**
 * Where this spec's attachment deletes are aimed.
 *
 * Named explicitly rather than left to the service's default, which resolves
 * `environment.userDataDir` — the one shared resource the specs redirect for
 * themselves. Nothing is written here; the service only ever removes
 * `<root>/<task uuid>`, which cannot exist for a freshly minted id.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-attachments-spec');

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
  let updateSettings: ReturnType<typeof vi.fn>;
  let startWorkflowRun: ReturnType<typeof vi.fn>;
  let deleteWorkflowRun: ReturnType<typeof vi.fn>;
  let deleteChat: ReturnType<typeof vi.fn>;
  let resolveAutoGroupId: ReturnType<typeof vi.fn>;

  /**
   * A complete run row on the wire.
   *
   * Annotated rather than cast, so a field the schema requires cannot go
   * missing here and still compile.
   */
  const runWire = (id: string): RunWire => ({
    id,
    status: 'pending',
    taskIdentifier: null,
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
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
    );
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
    // A REAL purge, not a stub answering `{ deleted: true }` about nothing —
    // the "does NOT delete the run" spec below asserts the row SURVIVES, and
    // that assertion means nothing against a double that removes no row.
    deleteChat = vi.fn(async (id: string) => {
      await runDao.hardDeleteIncludingSoftDeleted({ id }, em);
      return { deleted: true };
    });
    updateSettings = vi.fn(async () => undefined);
    const chats = {
      createChat,
      sendMessage,
      updateSettings,
      delete: deleteChat,
    } as unknown as ChatService;
    // The graph engine's double writes a real run row for `createChat`'s own
    // reason: the double-start guard asks the RUN whether it has settled, and
    // a workflow-targeted card must be refused a second start exactly as an
    // agent-targeted one is.
    startWorkflowRun = vi.fn(
      async (
        slug: string,
        input: { taskId?: string; title?: string; groupId?: string | null },
      ) => {
        const id = `wf-run-${(runSeq += 1)}`;
        await runDao.create({
          id,
          workflowId: slug,
          status: 'running',
          agentKind: null,
          cwd: worktree,
          taskId: input.taskId ?? null,
          groupId: input.groupId ?? null,
          title: input.title ?? null,
        });
        return runWire(id);
      },
    );
    deleteWorkflowRun = vi.fn(async () => ({ deleted: true }));
    const executor = {
      startRunBySlug: startWorkflowRun,
      deleteRun: deleteWorkflowRun,
    } as unknown as GraphExecutorService;
    // No sidebar rule claims anything by default; a test that needs one says so.
    resolveAutoGroupId = vi.fn(async () => null);
    const groups = { resolveAutoGroupId } as unknown as RunGroupsService;
    service = new TaskRunsService(
      em,
      taskDao,
      projectDao,
      runDao,
      tasks,
      chats,
      new ProjectQueueService(em, projectDao, taskDao, runDao),
      executor,
      groups,
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

  describe('the workflow arm', () => {
    /** Point the CARD at a workflow, leaving the project's agent in place. */
    const seedWorkflowCard = async (slug = 'dev-team') => {
      const task = await seed();
      const row = await taskDao.getById(task.id);
      (row as Task).workflowSlug = slug;
      await em.flush();
      return task;
    };

    it('starts a graph run instead of a chat when the card names a workflow', async () => {
      const task = await seedWorkflowCard();

      const started = await service.start(task.id, start());

      expect(startWorkflowRun).toHaveBeenCalledTimes(1);
      expect(createChat).not.toHaveBeenCalled();
      expect(started).toMatchObject({
        status: 'in_progress',
        runId: 'wf-run-1',
        worktreePath: worktree,
      });
    });

    it('hands the executor the card id, its title and the project’s group', async () => {
      const task = await seedWorkflowCard();

      await service.start(task.id, start());

      expect(startWorkflowRun).toHaveBeenCalledWith(
        'dev-team',
        expect.objectContaining({
          taskId: task.id,
          title: 'ship it',
          groupId: 'group-7',
          cwd: worktree,
        }),
      );
    });

    it('seeds the graph with the card’s brief and sends no second message', async () => {
      const task = await seedWorkflowCard();

      await service.start(task.id, start());

      // A graph's seed prompt IS its opening message — there is no
      // `POST /messages` for a workflow run to follow up on.
      expect(startWorkflowRun.mock.calls[0]?.[1]).toMatchObject({
        prompt: 'ship it',
      });
      expect(sendMessage).not.toHaveBeenCalled();
      void task;
    });

    it('asks a graph for a PROSE report, never naming a tool it cannot see', async () => {
      const task = await seedWorkflowCard();

      await service.start(task.id, start());

      // The render family is registered by `ChatService` alone, so no node of
      // this graph can call `report_findings`. Naming it would ask every node
      // for a call it will look for and fail to find.
      const instructions = String(
        startWorkflowRun.mock.calls[0]?.[1]?.customInstructions ?? '',
      );
      expect(instructions).not.toContain('report_findings');
      expect(instructions).toContain('close with a report');
      void task;
    });

    it('deletes the GRAPH run when the start fails, not through the chat path', async () => {
      const task = await seedWorkflowCard();
      // Fail after the run exists, which is the window `abandon` is for. The
      // real method is captured BEFORE the spy replaces it: binding
      // `tasks.update` afterwards binds the SPY, so every later call re-enters
      // it and the recursion is swallowed by `abandon`'s own catch — the test
      // then passes while reverting nothing.
      const real = tasks.update.bind(tasks);
      const boom = new Error('worktree vanished');
      const update = vi
        .spyOn(tasks, 'update')
        .mockRejectedValueOnce(boom)
        .mockImplementation(real);

      await expect(service.start(task.id, start())).rejects.toThrow(boom);

      // `chats.delete` asserts a CHAT run, so sending a graph run there throws
      // `NOT_A_CHAT_RUN` into a catch that swallows it — leaving the orphaned
      // run row this routing exists to prevent, and leaving it silently.
      expect(deleteWorkflowRun).toHaveBeenCalledWith('wf-run-1');
      expect(deleteChat).not.toHaveBeenCalled();
      // The card really did come back, which is what proves `abandon` ran to
      // completion rather than dying partway and being swallowed.
      expect((await taskDao.getById(task.id))?.status).toBe('todo');
      update.mockRestore();
    });

    it('lets the PROJECT name the workflow for every card on its board', async () => {
      const project = await projectDao.getById(projectId);
      (project as Project).agentKind = null;
      (project as Project).workflowSlug = 'board-wide';
      await em.flush();
      const task = await seed();

      await service.start(task.id, start());

      expect(startWorkflowRun).toHaveBeenCalledWith(
        'board-wide',
        expect.anything(),
      );
    });

    it('lets a CARD’s agent override a project pinned to a workflow', async () => {
      const project = await projectDao.getById(projectId);
      (project as Project).agentKind = null;
      (project as Project).workflowSlug = 'board-wide';
      await em.flush();
      const task = await seed();
      const row = await taskDao.getById(task.id);
      (row as Task).agentKind = 'cursor-agent';
      await em.flush();

      await service.start(task.id, start());

      expect(startWorkflowRun).not.toHaveBeenCalled();
      expect(createChat).toHaveBeenCalledWith(
        expect.objectContaining({ agentKind: 'cursor-agent' }),
      );
    });

    it('refuses to start a workflow-targeted card unattended', async () => {
      // The resolver's own refusal is pinned in `run-target.spec.ts` and the
      // queue's handout keeps such a card out of `eligible` in
      // `task-queue.service.spec.ts` — but neither reaches this throw, which is
      // the line: a workflow's nodes each carry their own approval mode, so
      // there is no single field to force the way an agent run's is, and an
      // autopilot start against one must never reach the executor at all.
      const task = await seedWorkflowCard();

      await expect(
        service.start(task.id, { ...start(), startedBy: 'autopilot' }),
      ).rejects.toMatchObject({
        errorCode: RUN_TARGET_PROBLEM_CODE['workflow-unattended'],
      });
      expect(startWorkflowRun).not.toHaveBeenCalled();
    });
  });

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
    // The project's group is a deliberate answer, so no rule is consulted.
    expect(resolveAutoGroupId).not.toHaveBeenCalled();
  });

  it('files the run under the group claiming the card’s REAL folder when the project names none', async () => {
    // REPORTED against the autopilot: "tasks have no folder of their own …
    // they land in UNGROUPED although they belong to the geniro folder". With
    // no project group the rule is asked about the folder the card works in —
    // never the worktree the run is given, which no rule has ever claimed.
    const loose = await projectDao.create({
      name: 'Loose',
      folder: '/tmp/geniro-task-runs-loose',
      agentKind: 'claude',
    });
    const task = await tasks.create({ projectId: loose.id, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    resolveAutoGroupId.mockResolvedValueOnce('folder-group');

    await service.start(task.id, start());

    expect(resolveAutoGroupId).toHaveBeenCalledWith({
      cwd: '/tmp/geniro-task-runs-loose',
      workflowId: null,
    });
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'folder-group' }),
    );
  });

  it('hands the chat the card’s IDENTIFIER as well as its id', async () => {
    // The sidebar labels a task thread `GEN-12`, and it holds run rows and no
    // board — so the run has to carry the name. It is two rows away (the
    // card's number, the project's key) and `v1/agents` may not read either,
    // which is why this service is what writes it down.
    const named = await projectDao.create({
      name: 'Geniro',
      folder: '/tmp/geniro-task-runs-named',
      agentKind: 'claude',
      taskKey: 'GEN',
    });
    const task = await tasks.create({ projectId: named.id, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskIdentifier: `GEN-${task.number}` }),
    );
  });

  it('says NOTHING for a board that has no key', async () => {
    // Absent rather than null: the create input spells it `taskIdentifier?:
    // string`, exactly as `taskId` is spelled, so a board from before
    // identifiers existed sends no field at all and the thread simply draws no
    // label — the same answer as a chat nobody started from a card.
    const task = await seed();

    await service.start(task.id, start());

    const sent = createChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('taskIdentifier' in sent).toBe(false);
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

  /** Work the card, settle its run, and send it back to `todo` for a re-run. */
  const settleAndReturn = async (taskId: string): Promise<void> => {
    const finished = await runDao.getById('run-1');
    if (finished) {
      finished.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(taskId, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();
    sendMessage.mockClear();
  };

  it('re-runs a settled card in the thread it already has', async () => {
    // REPORTED as "now i can run already completed task - and it will create
    // new thread", and settled as "let's always continue in existing one". The
    // conversation is the card's history; a second thread discards it and
    // leaves two rows in the sidebar under one card's identifier.
    //
    // Continuity is the point here, and a matching agent must not be read as a
    // change just because the target is now consulted on every start.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);

    await expect(service.start(task.id, start())).resolves.toMatchObject({
      status: 'in_progress',
      runId: 'run-1',
    });
    expect(createChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
  });

  it('sends a continued thread the user’s OWN words, not the brief again', async () => {
    // The brief is already in this conversation. Repeating it buries the one
    // new sentence under a paragraph the agent has read before.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);

    await service.start(task.id, start({ prompt: 'The tests still fail.' }));

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'The tests still fail.');
  });

  it('opens a NEW thread when the old one was deleted', async () => {
    // A card whose conversation the user threw away has nothing to continue,
    // and that is not an error — it is the ordinary way back to a fresh start.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    await runDao.hardDeleteIncludingSoftDeleted({ id: 'run-1' }, em);

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW thread when the old one is ARCHIVED', async () => {
    // An archived chat is inert by design — `sendMessage` refuses it with
    // `RUN_ARCHIVED` — so continuing into one would turn a press of Run into a
    // failure the user cannot act on from the board.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const shelved = await runDao.getById('run-1');
    if (shelved) {
      shelved.archivedAt = new Date();
      await em.flush();
    }

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW thread when the card has been re-pointed at another agent', async () => {
    // The Agent control is settable per card, and a card that has run once
    // would otherwise keep running the CLI it was first started on — panel
    // showing the new one, every press continuing the old thread, and no way
    // out short of deleting the run.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).agentKind = 'cursor-agent';
    await em.flush();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0]?.[0]).toMatchObject({
      agentKind: 'cursor-agent',
    });
    expect(sendMessage).not.toHaveBeenCalledWith('run-1', expect.anything());
  });

  it('forces the autopilot approval onto a thread it CONTINUES', async () => {
    // The deadlock the design calls non-negotiable, reached by the re-run path:
    // `ChatService` reads the mode off the RUN row and falls back to `ask`, so
    // an unattended turn resumed into a thread opened under any other mode
    // parks on a permission card forever — holding its slot and its worktree,
    // and invisible to the failure breaker, because parked is not failed.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    updateSettings.mockClear();

    await service.start(task.id, { ...start(), startedBy: 'autopilot' });

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    // EXACTLY that key and no other — not `objectContaining`, which is what let
    // the defect below through review. `updateSettings` branches on a key being
    // PRESENT, so an unresolved rung carried as an explicit null is an
    // instruction rather than silence.
    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      approval: AUTOPILOT_APPROVAL,
    });
  });

  it('sends NO settings patch when the card resolves none of them', async () => {
    // `configDir: null` is not "leave it alone": it reaches `moveToConfigDir`,
    // which refuses outright for a CLI that reads no config directory, so every
    // re-press on a cursor-agent card answered 400 — and `model: null` is a
    // CLEAR that takes the run's context window and model parameters with it.
    // This project names an agent and nothing else, so the correct patch is no
    // call at all.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('sends ONLY the rungs that resolved, never the ones that did not', async () => {
    // The mixed case the two specs above cannot reach on their own: one field
    // set on the card leaves the other three unresolved, and each of those is
    // destructive if carried through as a null.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).effort = 'high';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(updateSettings).toHaveBeenCalledWith('run-1', { effort: 'high' });
  });

  it('sends the two DESTRUCTIVE rungs when they resolve, and nothing else', async () => {
    // `model` and `configDir` are the pair whose presence carries a side
    // effect, so each needs a positive case of its own: with only the
    // absent-case and `effort` covered, a mistyped arm (`configDir:
    // target.model`) or a dropped `model` line would pass every other spec
    // here.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).model = 'opus';
    (row as Task).configDir = '/tmp/geniro-profile';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      model: 'opus',
      configDir: '/tmp/geniro-profile',
    });
  });

  it('omits a model the run is ALREADY on', async () => {
    // `updateSettings` reads a present `model` as a CHANGE and clears the
    // run's context window and model parameters with it, so re-pressing Run on
    // an unchanged card would silently drop a `1m` window the user set inside
    // that thread. Sending the value is as destructive as sending a null here;
    // only sending nothing is safe.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).model = 'opus';
    const runRow = await runDao.getById('run-1');
    (runRow as Run).model = 'opus';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does NOT delete the run when continuing it fails', async () => {
    // The whole difference between `resume`'s failure branch and `abandon`:
    // this thread is the card's history, and a transient send failure is not a
    // reason to destroy the conversation, its items and its attachments.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    expect(deleteChat).not.toHaveBeenCalled();
    expect(await runDao.getById('run-1')).not.toBeNull();
    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
  });

  /** Run a workflow-targeted card once, settle it, and return it to `todo`. */
  const runWorkflowAndReturn = async (taskId: string): Promise<void> => {
    const row = await taskDao.getById(taskId);
    (row as Task).workflowSlug = 'dev-team';
    await em.flush();
    await service.start(taskId, start());
    const finished = await runDao.getById('wf-run-1');
    if (finished) {
      finished.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(taskId, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();
    sendMessage.mockClear();
    startWorkflowRun.mockClear();
  };

  it('opens a second WORKFLOW run rather than continuing the old one', async () => {
    // A workflow target never resumes: the two engines share no channel, so a
    // re-run of a graph card is a second walk of the graph.
    const task = await seed();
    await runWorkflowAndReturn(task.id);

    await service.start(task.id, start());

    expect(startWorkflowRun).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses to send a chat message into a WORKFLOW run', async () => {
    // The card is re-pointed at an agent AFTER a graph run, so the press now
    // resolves to the agent arm while the run it holds is still a workflow
    // run. `sendMessage` is guarded by `assertChatRun` and would answer
    // `NOT_A_CHAT_RUN`, leaving the card permanently un-runnable.
    //
    // The row carries an `agentKind` as well, which a workflow run does not
    // normally have: without it the agent-match disqualifier one line below
    // already refuses this run, and the `workflowId` clause — the one this
    // test exists for — is never reached.
    const task = await seed();
    await runWorkflowAndReturn(task.id);
    const graphRun = await runDao.getById('wf-run-1');
    if (graphRun) {
      graphRun.agentKind = 'claude';
      await em.flush();
    }
    const row = await taskDao.getById(task.id);
    (row as Task).workflowSlug = null;
    await em.flush();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalledWith('wf-run-1', expect.anything());
  });

  it('carries the press’s own words into a NEW thread’s brief', async () => {
    const task = await seed({
      title: 'Fix the cap',
      description: 'Off by one.',
    });

    await service.start(task.id, start({ prompt: 'Start with the parser.' }));

    expect(sendMessage).toHaveBeenCalledWith(
      'run-1',
      'Fix the cap\n\nOff by one.\n\nStart with the parser.',
    );
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
      message: expect.stringContaining('no agent or workflow'),
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
