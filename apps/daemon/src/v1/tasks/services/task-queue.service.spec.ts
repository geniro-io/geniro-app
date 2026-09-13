import { mkdtempSync, rmSync } from 'node:fs';
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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { RunDao } from '../../agents/dao/run.dao';
import type { Workflow } from '../../graphs/graphs.types';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { RUN_TARGET_PROBLEM_REASON } from '../utils/run-target';
import {
  missingWorkflowReason,
  STOPPED_BY_USER_REASON,
  TaskQueueService,
} from './task-queue.service';

/** A minimal, valid single-node workflow — content is irrelevant to this spec. */
const DEV_TEAM_WORKFLOW: Workflow = {
  name: 'Dev Team',
  nodes: [{ id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' }],
  edges: [],
};

/**
 * Real database, real DAOs, real `WorkflowStoreService` over a throwaway
 * library directory — the split under test JOINS the two, so faking either
 * side would assert the wiring and prove nothing about the join.
 *
 * This spec owns the eligible/blocked tests that used to live in
 * `ProjectQueueService`'s own spec; that service now answers `readRaw` alone
 * (see its spec for the raw-count coverage).
 */
describe('TaskQueueService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let projectQueue: ProjectQueueService;
  let service: TaskQueueService;
  let workflows: WorkflowStoreService;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let folder: string;
  let workflowsDir: string;
  let projectId: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-task-queue-'));
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
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    runDao = new RunDao(em);
    projectQueue = new ProjectQueueService(em, projectDao, taskDao, runDao);

    workflowsDir = mkdtempSync(join(tmpdir(), 'geniro-task-queue-workflows-'));
    workflows = new WorkflowStoreService({ workflowsDir });
    // Present in the library for every test unless a test says otherwise — the
    // existing 'BLOCKS a card whose only target is a WORKFLOW' behaviour is
    // about a workflow that DOES exist (it is simply unattended-incapable),
    // which this fixture has to keep true to stay meaningful.
    await workflows.create(DEV_TEAM_WORKFLOW, 'dev-team');

    service = new TaskQueueService(projectQueue, workflows);

    const project = await projectDao.create({
      name: 'board',
      folder,
      // Names an agent, because the handout asks whether each card COULD be
      // started: a project with no agent and no workflow blocks every card on
      // its board, which is its own group of cases below rather than the
      // background condition for the ones about capacity and ordering.
      agentKind: 'claude',
      autopilotEnabled: true,
      autopilotIntakeStatus: 'todo',
      autopilotMaxConcurrent: 2,
    });
    await em.flush();
    projectId = project.id;
  });

  afterEach(() => {
    rmSync(workflowsDir, { recursive: true, force: true });
  });

  async function addTask(
    title: string,
    status: Task['status'],
    position: number,
    runId: string | null = null,
  ): Promise<Task> {
    const task = await taskDao.create({
      projectId,
      title,
      status,
      position,
      runId,
    });
    await em.flush();
    return task;
  }

  async function addRun(
    status: Run['status'],
    agentKind: Run['agentKind'] = 'claude',
  ): Promise<Run> {
    const run = await runDao.create({ status, agentKind });
    await em.flush();
    return run;
  }

  async function arm(patch: Partial<Project>): Promise<void> {
    const project = await projectDao.getById(projectId, em);
    Object.assign(project as Project, patch);
    await em.flush();
  }

  it('hands out the intake column, oldest first, when nothing is running', async () => {
    await addTask('second', 'todo', 1);
    await addTask('first', 'todo', 0);
    await addTask('not intake', 'backlog', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual([
      'first',
      'second',
    ]);
    expect(queue.waiting).toBe(2);
    expect(queue.running).toBe(0);
    expect(queue.cap).toBe(2);
  });

  // The handout is what the conductor cuts a worktree from, and it runs in
  // another process with only this reply in hand — so the inheritance is
  // resolved HERE. A card that names no folder takes the project's; one that
  // names its own keeps it, which is the whole point of the column.
  it('leaves a task whose run the user STOPPED to the user — the armed autopilot never restarts it', async () => {
    // REPORTED as "i stopped thread - and i seee my messae was sent second
    // time": the settle returns a stopped card to the intake column so a press
    // can start it again, and the armed autopilot read that as waiting work,
    // restarting the card within seconds and re-sending its brief.
    const stoppedRun = await addRun('cancelled');
    await addTask('stopped by me', 'todo', 0, stoppedRun.id);
    await addTask('waiting', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual(['waiting']);
    expect(queue.blocked).toEqual([
      expect.objectContaining({
        title: 'stopped by me',
        reason: STOPPED_BY_USER_REASON,
      }),
    ]);
  });

  it('does not flag a stopped task on a DISARMED board — nothing unattended would restart it', async () => {
    await arm({ autopilotEnabled: false });
    const stoppedRun = await addRun('cancelled');
    await addTask('stopped by me', 'todo', 0, stoppedRun.id);

    const queue = await service.read(projectId);

    expect(queue.blocked).toEqual([]);
  });

  it('hands out the folder each CARD names, else the project one', async () => {
    const own = mkdtempSync(join(tmpdir(), 'geniro-card-'));
    try {
      const inherits = await addTask('inherits', 'todo', 0);
      const names = await addTask('names its own', 'todo', 1);
      names.folder = own;
      await em.flush();

      const queue = await service.read(projectId);

      expect(
        Object.fromEntries(
          queue.eligible.map((task) => [task.id, task.folder]),
        ),
      ).toEqual({ [inherits.id]: folder, [names.id]: own });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  // The conductor cuts a worktree BEFORE it asks the daemon to start the run,
  // so a card the start route would refuse costs a `git worktree add` and a
  // prune every tick, forever — the breaker cannot end it, because a run that
  // never started never failed. Keeping such a card out of `eligible` is what
  // stops that, and naming it is what lets the board explain itself.
  it('blocks a card no rung names an agent or a workflow for', async () => {
    await arm({ agentKind: null, workflowSlug: null });
    const orphan = await addTask('nothing to run me', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      { id: orphan.id, title: 'nothing to run me', reason: expect.any(String) },
    ]);
    // Still WAITING: it is in the intake column, which is what that count
    // means. `blocked` is what tells the two apart.
    expect(queue.waiting).toBe(1);
  });

  it('starts a card the CARD itself names an agent for, project silent', async () => {
    await arm({ agentKind: null, workflowSlug: null });
    const own = await addTask('names its own agent', 'todo', 0);
    own.agentKind = 'cursor-agent';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.id)).toEqual([own.id]);
    expect(queue.blocked).toEqual([]);
  });

  it('BLOCKS a card whose only target is a WORKFLOW', async () => {
    // A workflow carries `approval` per node, so there is no single field the
    // resolver can force the way it forces an agent run's — a node that asks
    // parks an unattended run forever, holding its slot and its worktree while
    // the failure breaker sees nothing wrong, because parked is not failed.
    // The card is answerable: point it at an agent, or press Run yourself.
    // 'dev-team' EXISTS in the library (see beforeEach) — this is the
    // unattended refusal, not the missing-workflow one below.
    await arm({ agentKind: null, workflowSlug: 'dev-team' });
    const card = await addTask('run me as a graph', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a graph',
        reason: RUN_TARGET_PROBLEM_REASON['workflow-unattended'],
      },
    ]);
  });

  it('names the two refusals differently', async () => {
    // The queue is where a user reads WHY a card is not being picked up, so a
    // card naming a workflow must not be told to name an agent or a workflow —
    // advice it has already followed.
    await arm({ agentKind: null, workflowSlug: null });
    const bare = await addTask('names nothing', 'todo', 0);
    const graph = await addTask('names a graph', 'todo', 1);
    graph.workflowSlug = 'dev-team';
    await em.flush();

    const queue = await service.read(projectId);

    const reasons = new Map(
      queue.blocked.map((task) => [task.id, task.reason]),
    );
    expect(reasons.get(bare.id)).toBe(RUN_TARGET_PROBLEM_REASON['no-target']);
    expect(reasons.get(graph.id)).toBe(
      RUN_TARGET_PROBLEM_REASON['workflow-unattended'],
    );
  });

  // A card naming a workflow the LIBRARY no longer holds — a workflow deleted
  // out from under a task (a rename keeps the file, so deletion is the
  // reachable cause; see `WorkflowStoreService.save`/`delete`). Without this
  // check the card would resolve as any other workflow target, land in
  // `blocked` under the generic 'workflow-unattended' reason, and a user
  // reading that would go looking for the wrong fix — pointing it at an
  // agent when the real problem is a dangling slug they could instead swap
  // for a workflow that still exists.
  it('blocks a card whose workflow slug is not in the library, with a reason naming it', async () => {
    await arm({ agentKind: null, workflowSlug: null });
    const card = await addTask('run me as a ghost graph', 'todo', 0);
    card.workflowSlug = 'ghost-workflow';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a ghost graph',
        reason: missingWorkflowReason('ghost-workflow'),
      },
    ]);
  });

  // A blocked card must not occupy one of the slots the handout is narrowed
  // to, or one misconfigured card at the head of a cap-1 column would starve
  // every runnable card behind it — the same standstill, reached the other way.
  it('does not let a blocked card consume a free slot', async () => {
    // The project names nothing, so a card is runnable only if it says so
    // itself. `blocked` sits at position 0 — ahead of `runnable` in the very
    // ordering the cap is applied to.
    await arm({
      agentKind: null,
      workflowSlug: null,
      autopilotMaxConcurrent: 1,
    });
    await addTask('blocked', 'todo', 0);
    const runnable = await addTask('runnable', 'todo', 1);
    runnable.agentKind = 'claude';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual(['runnable']);
    expect(queue.blocked.map((task) => task.title)).toEqual(['blocked']);
  });

  it('reports blocked cards even while the autopilot is disarmed', async () => {
    // A card naming nothing is broken whether or not the timer is running, and
    // a user who arms the project to find out why nothing happens has been
    // told nothing.
    await arm({ agentKind: null, workflowSlug: null, autopilotEnabled: false });
    await addTask('nothing to run me', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toHaveLength(1);
  });

  it('names a MISSING workflow on a disarmed board too, not just an armed one', async () => {
    // The library check used to sit inside the 'workflow-unattended' arm, which
    // `resolveRunTarget` only produces under 'autopilot' — so on a disarmed
    // board a card naming a deleted workflow resolved cleanly to
    // `{kind: 'workflow'}` and landed in `startable`. Nothing said it was
    // broken, and a hand press cut a worktree before 404ing
    // WORKFLOW_NOT_FOUND: the same dead end the armed board's churn loop is,
    // reached by the one door left open there.
    await arm({
      agentKind: null,
      workflowSlug: null,
      autopilotEnabled: false,
    });
    const card = await addTask('run me as a ghost graph', 'todo', 0);
    card.workflowSlug = 'ghost-workflow';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a ghost graph',
        reason: missingWorkflowReason('ghost-workflow'),
      },
    ]);
  });

  it('prefers the MISSING-workflow reason over the unattended one', async () => {
    // Both refusals apply to an armed board's workflow card; the specific one
    // has to win. A user told "cannot run unattended" about a card whose
    // workflow no longer exists goes looking for the wrong fix — repointing it
    // at an agent, when picking a different, real workflow is just as
    // available.
    await arm({ agentKind: null, workflowSlug: null });
    const card = await addTask('run me as a ghost graph', 'todo', 0);
    card.workflowSlug = 'ghost-workflow';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.blocked[0]?.reason).toBe(
      missingWorkflowReason('ghost-workflow'),
    );
  });

  it('narrows the handout to the free slots', async () => {
    const run = await addRun('running');
    await addTask('working', 'in_progress', 0, run.id);
    await addTask('a', 'todo', 1);
    await addTask('b', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(1);
    // Two waiting, a cap of two, one slot taken — so one goes out, not two.
    expect(queue.waiting).toBe(2);
    expect(queue.eligible.map((task) => task.title)).toEqual(['a']);
  });

  it('hands out nothing while the project is disarmed, and still reports the column', async () => {
    await arm({ autopilotEnabled: false });
    await addTask('a', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.enabled).toBe(false);
    expect(queue.eligible).toEqual([]);
    expect(queue.waiting).toBe(1);
  });

  it('hands out nothing when every slot is taken', async () => {
    const first = await addRun('running');
    const second = await addRun('pending');
    await addTask('one', 'in_progress', 0, first.id);
    await addTask('two', 'in_progress', 1, second.id);
    await addTask('queued', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(2);
    expect(queue.eligible).toEqual([]);
  });

  it('reads the intake column the project names, not a hardcoded one', async () => {
    await arm({ autopilotIntakeStatus: 'backlog' });
    await addTask('in backlog', 'backlog', 0);
    await addTask('in todo', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.intakeStatus).toBe('backlog');
    expect(queue.eligible.map((task) => task.title)).toEqual(['in backlog']);
  });
});
