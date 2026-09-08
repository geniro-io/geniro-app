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

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { Workflow } from '../../graphs/graphs.types';
import type { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../../projects/projects.types';
import { isBreakerOpen } from '../../projects/utils/breaker';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind, RunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskEventBus } from './task-events.bus';
import { TaskSettleService } from './task-settle.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout. What is under test is where a card lands and which
 * transcript row is recorded as its report — both are reads of stored state,
 * so faking the store would leave nothing to observe.
 */
describe('TaskSettleService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskSettleService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let getWorkflow: ReturnType<typeof vi.fn>;
  const workflows = new Map<string, Workflow>();
  let itemDao: ItemDao;
  let em: EntityManager;
  let bus: AgentEventBus;
  let taskEvents: TaskEventBus;
  let changes: TaskChangedEvent[];
  let projectId: string;
  let seq = 0;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Project, Task, Run, Item],
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
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    seq = 0;
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    itemDao = new ItemDao(em);
    taskEvents = new TaskEventBus();
    changes = [];
    taskEvents.allChanges().subscribe((event) => changes.push(event));
    tasks = new TasksService(em, taskDao, projectDao, taskEvents);
    bus = new AgentEventBus();
    // The library is asked only for a WORKFLOW run's terminal nodes; a chat
    // run never reaches it, which is what `getWorkflow` not being called in
    // the chat cases asserts.
    getWorkflow = vi.fn(async (slug: string) => {
      const workflow = workflows.get(slug);
      if (!workflow) {
        throw new Error(`no workflow ${slug}`);
      }
      return { workflow };
    });
    service = new TaskSettleService(
      em,
      bus,
      runDao,
      itemDao,
      taskDao,
      projectDao,
      tasks,
      { get: getWorkflow } as unknown as WorkflowStoreService,
    );
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-settle-spec',
    });
    projectId = project.id;
  });

  /** A card already in `in_progress` with a live run working it. */
  const working = async (runId = 'run-1') => {
    const task = await tasks.create({ projectId, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      workflowId: null,
      status: 'running',
      agentKind: 'claude',
      taskId: task.id,
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  const row = async (
    runId: string,
    kind: ItemKind,
    role: string | null,
    payload: string,
  ) => {
    seq += 1;
    return itemDao.create({ runId, seq, kind, role, payload });
  };

  /**
   * A card worked by a WORKFLOW run of `slug`, whose graph is registered with
   * the store double.
   *
   * The shape is the one a fan-out actually takes: `plan` feeds two reviewers,
   * and `sum` collects them. Only `sum` is terminal — which is the whole point,
   * because a reviewer routinely writes the last row.
   */
  const workingGraph = async (runId = 'wf-1', slug = 'dev-team') => {
    workflows.set(slug, {
      name: 'Dev team',
      nodes: [
        { id: 'plan', kind: 'agent', agent: 'claude', label: 'plan' },
        { id: 'a', kind: 'agent', agent: 'claude', label: 'a' },
        { id: 'b', kind: 'agent', agent: 'claude', label: 'b' },
        { id: 'sum', kind: 'agent', agent: 'claude', label: 'sum' },
      ],
      edges: [
        { from: 'plan', to: 'a', kind: 'data' },
        { from: 'plan', to: 'b', kind: 'data' },
        { from: 'a', to: 'sum', kind: 'data' },
        { from: 'b', to: 'sum', kind: 'data' },
      ],
    } as unknown as Workflow);
    const task = await tasks.create({ projectId, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      workflowId: slug,
      status: 'running',
      agentKind: null,
      taskId: task.id,
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  /** A transcript row attributed to one node of a workflow run. */
  const nodeRow = async (
    runId: string,
    nodeId: string,
    kind: ItemKind,
    role: string | null,
    payload: string,
  ) => {
    seq += 1;
    return itemDao.create({ runId, seq, kind, role, payload, nodeId });
  };

  const settleRun = async (runId: string, status: RunStatus) => {
    const run = await runDao.getById(runId);
    if (run) {
      run.status = status;
      await em.flush();
    }
    await service.settle(runId, status);
  };

  it('moves the card to review and records the structured report', async () => {
    const task = await working();
    await row('run-1', 'message', 'assistant', '{"text":"working on it"}');
    const report = await row(
      'run-1',
      'report_findings',
      null,
      '{"findings":[]}',
    );

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.reportItemId).toBe(report.id);
  });

  it('falls back to the agent’s last message when no report was emitted', async () => {
    const task = await working();
    await row('run-1', 'message', 'assistant', '{"text":"first"}');
    const last = await row('run-1', 'message', 'assistant', '{"text":"done"}');

    await settleRun('run-1', 'completed');

    expect((await taskDao.getById(task.id))?.reportItemId).toBe(last.id);
  });

  describe('a workflow run’s report', () => {
    it('takes a TERMINAL node’s message, not whichever node wrote last', async () => {
      const task = await workingGraph();
      const conclusion = await nodeRow(
        'wf-1',
        'sum',
        'message',
        'assistant',
        '{"text":"all three landed"}',
      );
      // A reviewer straggling in after the collector is the ordinary shape of
      // a fan-out, and it is the highest `seq` in the run. Reading the
      // transcript's last row would file THIS as the card's report.
      await nodeRow(
        'wf-1',
        'b',
        'message',
        'assistant',
        '{"text":"finished my slice"}',
      );

      await settleRun('wf-1', 'completed');

      expect((await taskDao.getById(task.id))?.reportItemId).toBe(
        conclusion.id,
      );
    });

    it('prefers a terminal node’s structured report over its prose', async () => {
      const task = await workingGraph();
      const findings = await nodeRow(
        'wf-1',
        'sum',
        'report_findings',
        'assistant',
        '{"findings":[]}',
      );
      await nodeRow('wf-1', 'sum', 'message', 'assistant', '{"text":"done"}');

      await settleRun('wf-1', 'completed');

      expect((await taskDao.getById(task.id))?.reportItemId).toBe(findings.id);
    });

    it('ignores a non-terminal node’s structured report', async () => {
      const task = await workingGraph();
      // A caller node holds an MCP endpoint and so CAN call the tool — but its
      // findings are its own contribution, not the run's conclusion.
      await nodeRow('wf-1', 'a', 'report_findings', 'assistant', '{}');
      const conclusion = await nodeRow(
        'wf-1',
        'sum',
        'message',
        'assistant',
        '{"text":"summed up"}',
      );

      await settleRun('wf-1', 'completed');

      expect((await taskDao.getById(task.id))?.reportItemId).toBe(
        conclusion.id,
      );
    });

    it('falls back to the whole transcript when the workflow cannot be read', async () => {
      const task = await workingGraph('wf-1', 'since-deleted');
      workflows.delete('since-deleted');
      const last = await nodeRow(
        'wf-1',
        'a',
        'message',
        'assistant',
        '{"text":"whatever I said"}',
      );

      await settleRun('wf-1', 'completed');

      // A workflow edited, renamed or deleted since the run started still
      // settled a real card: the last message of an unknown shape is a better
      // report than none at all.
      expect((await taskDao.getById(task.id))?.reportItemId).toBe(last.id);
    });

    it('never asks the library about a CHAT run', async () => {
      const task = await working();
      await row('run-1', 'message', 'assistant', '{"text":"done"}');

      await settleRun('run-1', 'completed');

      expect(getWorkflow).not.toHaveBeenCalled();
      expect((await taskDao.getById(task.id))?.reportItemId).not.toBeNull();
    });
  });

  it('never reports the USER’s own message back as the agent’s report', async () => {
    const task = await working();
    const agent = await row('run-1', 'message', 'assistant', '{"text":"done"}');
    // The user replies after the agent's last word — newest, and not a report.
    await row('run-1', 'message', 'user', '{"text":"thanks"}');

    await settleRun('run-1', 'completed');

    expect((await taskDao.getById(task.id))?.reportItemId).toBe(agent.id);
  });

  it('marks the card failed when the run fails', async () => {
    const task = await working();

    await settleRun('run-1', 'failed');

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('returns the card to todo when the user stops the run themselves', async () => {
    const task = await working();

    await settleRun('run-1', 'cancelled');

    // A cancel is the user stopping their own agent — they did not fail at
    // anything, and the card has to be startable again.
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
  });

  it('leaves a card alone when it has moved on to a different run', async () => {
    const task = await working('run-old');
    // The card was re-started; an older run settling must not drag it back.
    await tasks.update(task.id, { runId: 'run-new' });

    await settleRun('run-old', 'completed');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('does nothing on a status the run has not settled into', async () => {
    const task = await working();

    await service.settle('run-1', 'running');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('reconciles a run that settled while the app was closed, WITH its report', async () => {
    const task = await working();
    const last = await row(
      'run-1',
      'message',
      'assistant',
      '{"text":"all done"}',
    );
    // The settle happened with no window open, so nothing was broadcast: the
    // run row is terminal while the card still reads as working.
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'completed';
      await em.flush();
    }

    const board = await service.reconcileProject(projectId);

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    // The point of the whole exercise: the closing words rode an event that is
    // long gone, so a reconcile reading only the status would land an EMPTY
    // report. It reads the transcript instead.
    expect(stored?.reportItemId).toBe(last.id);
    expect(board.find((row) => row.id === task.id)?.status).toBe('in_review');
  });

  it('leaves a still-running card alone when a board reconciles', async () => {
    const task = await working();

    await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('settles from the LIVE bus, which is how every card moves', async () => {
    const task = await working();
    const last = await row('run-1', 'message', 'assistant', '{"text":"done"}');
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'completed';
      await em.flush();
    }
    service.onModuleInit();

    bus.publishRunStatus({
      runId: 'run-1',
      status: 'completed',
      at: new Date().toISOString(),
    });
    // The subscriber detaches its work, so yield a full turn of the event
    // loop — every await under it resolves synchronously (better-sqlite3), so
    // one macrotask is enough for the whole chain.
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.reportItemId).toBe(last.id);
  });

  it('ignores an activity announce, which asserts nothing about settling', async () => {
    const task = await working();
    service.onModuleInit();

    // A null status says only what the run is DOING.
    bus.publishRunStatus({
      runId: 'run-1',
      status: null,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('settles a card ONCE, so a follow-up turn cannot drag it back', async () => {
    const task = await working();
    await settleRun('run-1', 'completed');
    // The run is an ordinary chat: the user reviews, moves the card on, then
    // asks the agent one more thing in that same conversation.
    await tasks.moveStatus(task.id, { from: 'in_review', to: 'done' });

    await settleRun('run-1', 'completed');

    expect((await taskDao.getById(task.id))?.status).toBe('done');
  });

  it('one contested card does not cost the board its whole listing', async () => {
    const task = await working();
    const other = await tasks.create({ projectId, title: 'untouched' });
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'completed';
      await em.flush();
    }
    // `settle` ends in a compare-and-set that throws when the row moved since
    // it was read — this is that throw, driven directly, because reproducing
    // the race needs a second writer landing between one card's read and its
    // write. `reconcileTasks` is the board's ONLY listing call, so without the
    // per-card catch this one card takes every other one with it.
    const moved = vi
      .spyOn(tasks, 'moveStatus')
      .mockRejectedValueOnce(new Error('TASK_STATUS_CONFLICT'));

    const board = await service.reconcileProject(projectId);

    expect(moved).toHaveBeenCalledTimes(1);
    expect(board.map((r) => r.id)).toEqual(
      expect.arrayContaining([task.id, other.id]),
    );
    // The contested card is left exactly where the failed move found it.
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  // ── The failure breaker ────────────────────────────────────────────────────

  /**
   * Read the project back through a FRESH fork.
   *
   * `settle` writes on its own fork, so the shared EM's identity map still
   * holds the row as it was before — a read through it would assert against a
   * copy the service never touched.
   */
  const freshProject = async (): Promise<Project> => {
    const fork = orm.em.fork() as EntityManager;
    return (await new ProjectDao(fork).getById(projectId, fork)) as Project;
  };

  const streak = async (): Promise<number> =>
    (await freshProject()).autopilotFailureStreak;

  const armProject = async (patch: {
    enabled?: boolean;
    streak?: number;
  }): Promise<void> => {
    const project = await projectDao.getById(projectId, em);
    if (patch.enabled !== undefined) {
      (project as Project).autopilotEnabled = patch.enabled;
    }
    if (patch.streak !== undefined) {
      (project as Project).autopilotFailureStreak = patch.streak;
    }
    await em.flush();
  };

  it('counts a failed run against an armed project', async () => {
    await armProject({ enabled: true });
    const task = await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(1);
    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('opens the breaker at the threshold, and not one failure sooner', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD - 2,
    });

    await working('run-a');
    await service.settle('run-a', 'failed');
    expect(isBreakerOpen(await freshProject())).toBe(false);

    await working('run-b');
    await service.settle('run-b', 'failed');
    expect(await streak()).toBe(PROJECT_FAILURE_BREAKER_THRESHOLD);
    expect(isBreakerOpen(await freshProject())).toBe(true);
  });

  it('clears the streak on a success', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD,
    });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  // A success is evidence the thing works, whoever pressed it — so it clears
  // the count even on a project nobody has armed.
  it('clears the streak on a success even while disarmed', async () => {
    await armProject({ enabled: false, streak: 2 });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  // The streak is a claim about UNATTENDED work. A person re-running something
  // they know is broken, on a project nobody armed, is not building evidence
  // for a breaker that is guarding nothing.
  it('does not count a failure on a disarmed project', async () => {
    await armProject({ enabled: false, streak: 0 });
    await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(0);
  });

  // Neither a fault to count nor a success to clear one.
  it('leaves the streak alone when the user cancels', async () => {
    await armProject({ enabled: true, streak: 2 });
    await working();

    await service.settle('run-1', 'cancelled');

    expect(await streak()).toBe(2);
  });

  it('names the SETTLE as the reason the card moved', async () => {
    const task = await working();

    await settleRun('run-1', 'completed');

    // The client cannot derive this: a card's column is written optimistically
    // the moment it is dragged, so only the daemon can say an agent stopped —
    // and the renderer collects the worktree off exactly this field.
    expect(
      changes.filter((event) => event.taskId === task.id).at(-1),
    ).toMatchObject({ status: 'in_review', reason: 'run-settled' });
  });

  it('gives NO reason for a move the user made themselves', async () => {
    const task = await working();

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    // A drag reaches the same broadcast. Were it to carry the reason, the
    // renderer would remove the worktree of an agent still working in it.
    expect(changes.at(-1)?.reason).toBeUndefined();
  });

  it('releases a card whose run was deleted, and lets it be run again', async () => {
    const task = await working();
    await tasks.update(task.id, { reportItemId: 'item-1' });
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    // The run is gone, so the card names a conversation nothing can answer
    // for. Left holding it, it sits in `in_progress` for good with Run
    // disabled — the button asks the RUN, and a missing run is not a settled
    // one.
    expect(stored?.runId).toBeNull();
    expect(stored?.status).toBe('todo');
    // The row it pointed at was hard-deleted with the transcript.
    expect(stored?.reportItemId).toBeNull();
  });

  it('leaves a REVIEWED card in its column when its run is deleted', async () => {
    const task = await working();
    await settleRun('run-1', 'completed');
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    // Only a card that was being WORKED has to be sent back — one already
    // reviewed has moved on, and dragging it backwards would undo the user.
    expect(stored?.status).toBe('in_review');
    expect(stored?.runId).toBeNull();
  });

  it('ignores a deleted run no card ever held', async () => {
    const task = await working();
    service.onModuleInit();

    bus.publishRunDeleted('some-other-run');
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.runId).toBe('run-1');
  });
});
