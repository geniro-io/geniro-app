import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { GraphExecutorService } from '../../graphs/services/graph-executor.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { taskIdentifier } from '../../projects/utils/project-key';
import { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import {
  type ResolvedRunTarget,
  type StartTaskRun,
  TaskFileSchema,
  type TaskFileWire,
  type TaskWire,
} from '../tasks.types';
import { NO_RUN_TARGET_REASON, resolveRunTarget } from '../utils/run-target';
import {
  composeTaskPrompt,
  TASK_REPORT_INSTRUCTIONS,
  TASK_REPORT_INSTRUCTIONS_WORKFLOW,
} from '../utils/task-prompt';
import { TasksService } from './tasks.service';

/**
 * Starting an agent on a task.
 *
 * The card is what the user presses; an ordinary CHAT is what runs. That is
 * the whole design — a task run is not a second execution path, it is
 * `ChatService` called with a worktree as its cwd, which is why this module
 * imports `AgentsModule` rather than growing an engine of its own.
 *
 * It runs no git. The worktree and the branch arrive already made, from the
 * Electron main process, because every git call in this app belongs there.
 */
@Injectable()
export class TaskRunsService {
  private readonly logger = new Logger(TaskRunsService.name);

  /**
   * Tasks whose start is in flight, claimed synchronously.
   *
   * `TasksService.moveStatus` is a compare-and-set, and it is what stops two
   * BOARDS double-starting one card — but it reads and then writes with an
   * await between, so two requests arriving together can both find the card in
   * `todo` and both pass. `ChatService.sendMessage` closes the identical
   * window with the identical mechanism, and its reasoning applies unchanged:
   * reserve before the first await, since the cost of losing the race is two
   * agents in two worktrees working one task.
   */
  private readonly starting = new Set<string>();

  /**
   * One project's starts, serialized.
   *
   * The `starting` Set above stops one CARD being started twice; this stops
   * one PROJECT exceeding its cap, which is a different race and is not
   * covered by it. Two conductors picking two DIFFERENT eligible tasks both
   * count the running runs, both find a slot free, and both start — the cap is
   * exceeded without either card being touched twice, so neither the Set nor
   * the status compare-and-set can see it.
   *
   * In-process serialization is sufficient because there is exactly one
   * daemon per userData dir, which `utils/instance-lock.ts` enforces — every
   * window's conductor reaches this one map. A second daemon would defeat it,
   * and is refused at boot for its own reasons.
   */
  private readonly perProject = new Map<string, Promise<unknown>>();

  constructor(
    private readonly em: EntityManager,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly runDao: RunDao,
    private readonly tasks: TasksService,
    private readonly chats: ChatService,
    private readonly queue: ProjectQueueService,
    private readonly executor: GraphExecutorService,
  ) {}

  async start(taskId: string, input: StartTaskRun): Promise<TaskWire> {
    if (this.starting.has(taskId)) {
      throw new ConflictException(
        'TASK_RUN_STARTING',
        `task ${taskId} is already starting a run`,
      );
    }
    this.starting.add(taskId);
    try {
      const projectId = await this.projectIdOf(taskId);
      return await this.queued(projectId, () =>
        this.startClaimed(taskId, input),
      );
    } finally {
      this.starting.delete(taskId);
    }
  }

  /**
   * Run `fn` after every start already queued for this project.
   *
   * The chain is kept on failures too — a start that threw still finished, and
   * dropping the tail there would let the next caller run beside one still in
   * flight. The entry is deleted only when this call is still the tail, so a
   * later start that has already chained onto it is never orphaned.
   */
  private async queued<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.perProject.get(projectId) ?? Promise.resolve();
    const mine = prior.then(fn, fn);
    this.perProject.set(
      projectId,
      mine.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await mine;
    } finally {
      const tail = this.perProject.get(projectId);
      if (tail !== undefined) {
        void tail.then(() => {
          if (this.perProject.get(projectId) === tail) {
            this.perProject.delete(projectId);
          }
        });
      }
    }
  }

  private async projectIdOf(taskId: string): Promise<string> {
    const em = this.em.fork();
    return (await this.require(taskId, em)).projectId;
  }

  private async startClaimed(
    taskId: string,
    input: StartTaskRun,
  ): Promise<TaskWire> {
    const em = this.em.fork();
    const task = await this.require(taskId, em);
    const project = await this.requireProject(task.projectId, em);
    // Most specific first: this press, then the card, then the project. The
    // first rung naming a target decides whether an agent or a workflow runs.
    const target = resolveRunTarget([input, task, project], input.startedBy);
    if (target === null) {
      throw new BadRequestException(
        'TASK_RUN_NO_AGENT',
        `${NO_RUN_TARGET_REASON} (${project.id})`,
      );
    }
    await this.assertNotAlreadyRunning(task, em);
    await this.assertAutopilotMayStart(project, input);

    // The MOVE is the reservation, which is why it happens before the chat
    // exists rather than after: a card sitting in `in_progress` is what a
    // second board's start is refused against. Everything after it is undone
    // by `abandon` if the run cannot be made.
    await this.tasks.moveStatus(taskId, {
      from: input.from,
      to: 'in_progress',
    });

    // A card that has already been worked CONTINUES its own thread rather than
    // opening a second one beside it. REPORTED as "now i can run already
    // completed task - and it will create new thread", then settled in one
    // line: "let's even not ask user to create new chat - let's always continue
    // in existing one". The conversation IS the card's history — what was
    // tried, what the user said about it, what the agent found — and starting
    // cold discards all of it and leaves two threads for one card in a sidebar
    // that now labels both `GEN-12`.
    //
    // Before the create arms rather than inside them, because both are the
    // same decision: the run this card already holds is the run it should be
    // worked in, whichever engine made it.
    const resumed = await this.resume(task, input, em);
    if (resumed !== null) {
      return resumed;
    }

    // Held so `abandon` can take the run down with the rest. Without it a
    // failure after creation leaves a run whose `taskId` points at a card that
    // no longer names it, working directory already pruned by the caller.
    let runId: string | null = null;
    try {
      if (target.kind === 'workflow') {
        const run = await this.startWorkflowRun(target.workflowSlug, {
          task,
          project,
          input,
        });
        runId = run.id;
        // No `sendMessage` here, and that is the arm's whole difference: a
        // graph's seed prompt IS its opening message, persisted by the
        // executor before it walks. There is no second channel to send on —
        // `POST /v1/chats/:runId/messages` is chat-only.
        return await this.recordRun(taskId, run.id, input);
      }

      const run = await this.chats.createChat({
        agentKind: target.agentKind,
        cwd: input.cwd,
        startSha: input.startSha,
        startDirty: input.startDirty,
        model: target.model ?? undefined,
        effort: target.effort ?? undefined,
        approval: target.approval ?? undefined,
        configDir: target.configDir ?? undefined,
        customInstructions: this.composeInstructions(
          input.customInstructions,
          'agent',
        ),
        // The card's own title, so the thread is findable in a sidebar that
        // lists it beside every other conversation. `ChatTitleService` leaves
        // a titled run alone, so this is not overwritten later.
        title: task.title,
        taskId: task.id,
        // And what that card is CALLED, written onto the run beside the id it
        // belongs to. The chat list draws it as the thread's own label, which
        // is the whole reason it is denormalized: the sidebar holds run rows
        // and no board — see `Run.taskIdentifier`.
        ...identifierOf(task, project),
        // The PROJECT's group rather than the folder rule: the run works in a
        // worktree, a path nothing has ever been filed under.
        groupId: project.groupId,
      });

      runId = run.id;
      const wire = await this.recordRun(taskId, run.id, input);
      await this.chats.sendMessage(run.id, this.brief(task, input));
      return wire;
    } catch (error) {
      await this.abandon(taskId, input.from, runId, target.kind);
      throw error;
    }
  }

  /**
   * Start the graph arm.
   *
   * The three overrides it passes are the whole of what a task run needs the
   * executor to do differently, and each is an answer the library route has no
   * way to give: the card's `taskId` (so `TaskSettleService` can move it when
   * the graph finishes), the card's own title (so the sidebar names the WORK
   * rather than restating which workflow ran), and the project's group (a
   * worktree being a path no auto-file rule has ever seen).
   */
  private startWorkflowRun(
    slug: string,
    context: { task: Task; project: Project; input: StartTaskRun },
  ): Promise<{ id: string }> {
    const { task, project, input } = context;
    return this.executor.startRunBySlug(slug, {
      cwd: input.cwd,
      prompt: this.brief(task, input),
      customInstructions: this.composeInstructions(
        input.customInstructions,
        'workflow',
      ),
      taskId: task.id,
      ...identifierOf(task, project),
      title: task.title,
      groupId: project.groupId,
    });
  }

  /**
   * Continue the card's existing thread, or answer null when there is none to
   * continue and a new one has to be made.
   *
   * FOUR states disqualify a run, and each one is a real card rather than a
   * defensive branch: the card has never been run; its run was DELETED by the
   * user (the conversation is gone, so there is nothing to continue); its run
   * is a WORKFLOW run, which has no chat channel to send on — `sendMessage` is
   * guarded by `assertChatRun` and would throw; or its run is ARCHIVED, which
   * the daemon holds inert on purpose (`RUN_ARCHIVED`). In every one of them
   * the answer is the same and it is not an error: make a new thread.
   *
   * A run still WORKING is not among them — `assertNotAlreadyRunning` has
   * already refused the press by the time this is reached.
   *
   * On failure the card is put back where it came from, and the RUN is left
   * exactly as it is. That is the whole difference from `abandon`, which
   * deletes what it started: this thread is the card's history, and a send
   * that failed is not a reason to destroy it.
   */
  private async resume(
    task: Task,
    input: StartTaskRun,
    em: EntityManager,
  ): Promise<TaskWire | null> {
    const run = await this.resumableRun(task, em);
    if (run === null) {
      return null;
    }
    try {
      // The card is re-pointed at its own run BEFORE the turn starts, on the
      // create path's own reasoning: `recordRun` also writes the worktree and
      // branch this press prepared, and the settle path reads them.
      const wire = await this.recordRun(task.id, run.id, input);
      await this.chats.sendMessage(run.id, this.continuation(task, input));
      return wire;
    } catch (error) {
      await this.tasks.moveStatus(task.id, {
        from: 'in_progress',
        to: input.from,
      });
      throw error;
    }
  }

  /** The card's own run, when it is one this daemon can send a message to. */
  private async resumableRun(
    task: Task,
    em: EntityManager,
  ): Promise<Run | null> {
    if (task.runId === null) {
      return null;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (
      !run ||
      run.workflowId !== null ||
      run.archivedAt !== null ||
      !isTerminalRunStatus(run.status)
    ) {
      return null;
    }
    return run;
  }

  /**
   * What a NEW thread opens with: the card's brief, plus whatever the user
   * added to this press.
   *
   * The addition goes after the description and BEFORE the attachment list,
   * which stays last for the reason `composeTaskPrompt` records — a CLI names
   * the conversation from this text, and a list of paths at the top titles the
   * chat after somebody's folder.
   */
  private brief(task: Task, input: StartTaskRun): string {
    return composeTaskPrompt(task, attachedFiles(task), input.prompt);
  }

  /**
   * What a CONTINUED thread is sent, which is deliberately not the same thing.
   *
   * The user's own words when they wrote any: the brief is already in this
   * conversation, and repeating it would bury the one new sentence under a
   * paragraph the agent has read before.
   *
   * The brief again when they wrote none, and that is the useful default
   * rather than a filler: pressing Run a second time with nothing to add means
   * "work this card again", and the card may have CHANGED since the first
   * press — an edited description, a file attached — so the brief is both the
   * honest restatement and the only way those edits reach the agent.
   */
  private continuation(task: Task, input: StartTaskRun): string {
    const added = input.prompt?.trim() ?? '';
    return added === '' ? this.brief(task, input) : added;
  }

  /**
   * Write the run onto the card — the other end of the edge, in one update.
   */
  private recordRun(
    taskId: string,
    runId: string,
    input: StartTaskRun,
  ): Promise<TaskWire> {
    return this.tasks.update(taskId, {
      runId,
      branch: input.branch,
      worktreePath: input.cwd,
    });
  }

  /**
   * Put the card back where the press found it.
   *
   * Its own failure is swallowed: the caller is owed the error that actually
   * stopped the run, and a card someone else moved in the meantime is not this
   * request's to drag back.
   */
  private async abandon(
    taskId: string,
    from: Task['status'],
    runId: string | null,
    kind: ResolvedRunTarget['kind'] = 'agent',
  ): Promise<void> {
    try {
      // The CARD first. Everything here is best-effort, and of the two the card
      // is what a user can be stuck on: left in `in_progress` it is refused by
      // the very guard that protects a live run, so a failure while cleaning up
      // would cost them the ability to start it again.
      await this.tasks.update(taskId, {
        runId: null,
        branch: null,
        worktreePath: null,
      });
      await this.tasks.moveStatus(taskId, { from: 'in_progress', to: from });
    } catch (error) {
      this.logger.warn(
        `could not return task ${taskId} to ${from} after a failed start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    // Its OWN catch, so a failing teardown cannot swallow the card revert
    // above — which is the half a user can be stuck on. `Run.taskId` and
    // `Task.runId` are two ends of one edge, and a chat left naming a card
    // that no longer names it back is the disagreement `run.entity.ts` says
    // nothing writes.
    //
    // Routed by ENGINE, because both deletes are kind-guarded: `chats.delete`
    // asserts a chat run and `deleteRun` asserts a workflow one, so sending a
    // graph run to the chat teardown throws `NOT_A_CHAT_RUN` — swallowed by
    // the catch below, leaving exactly the orphaned run row this block exists
    // to prevent, and leaving it silently.
    if (runId !== null) {
      try {
        await (kind === 'workflow'
          ? this.executor.deleteRun(runId)
          : this.chats.delete(runId));
      } catch (error) {
        this.logger.warn(
          `could not delete run ${runId} after a failed start: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /**
   * geniro's ask on top of the user's own.
   *
   * Theirs first, on `composeSystemPrompt`'s ordering: general before
   * specific, and the report is the specific half.
   */
  private composeInstructions(
    own: string | undefined,
    kind: ResolvedRunTarget['kind'],
  ): string {
    const ask =
      kind === 'workflow'
        ? TASK_REPORT_INSTRUCTIONS_WORKFLOW
        : TASK_REPORT_INSTRUCTIONS;
    const user = own?.trim() ?? '';
    return user === '' ? ask : `${user}\n\n${ask}`;
  }

  /**
   * Refuse a card whose agent is still working.
   *
   * The status check above cannot answer this on its own: a card dragged out
   * of `in_progress` by hand still points at the run it started, and starting
   * a second one would leave the first working in a worktree nothing names.
   *
   * It asks the RUN rather than merely noticing the id, because a settled run
   * is a card's history and not a claim on it — a task that has been through
   * review must be runnable again, and a bare `runId !== null` would refuse
   * every card that had ever run once.
   */
  /**
   * The cap and the breaker, enforced where the run is actually made.
   *
   * `GET /v1/projects/:id/queue` already narrows its handout to the free
   * slots, and that is a convenience rather than the guard: it answers a
   * conductor that asked, and nothing obliges a conductor to ask. This is the
   * line — the daemon refusing, over the rows, inside the per-project gate, so
   * two windows that polled in the same instant cannot both get past it.
   *
   * Only an autopilot start is bounded. A person pressing Run has decided to
   * spend the disk, and the breaker exists to stop UNATTENDED work — refusing
   * them is how they would be prevented from checking that the thing which
   * broke is fixed before they re-arm.
   */
  private async assertAutopilotMayStart(
    project: Project,
    input: StartTaskRun,
  ): Promise<void> {
    if ((input.startedBy ?? 'user') !== 'autopilot') {
      return;
    }
    const queue = await this.queue.read(project.id);
    if (queue.breakerOpen) {
      throw new ConflictException(
        'AUTOPILOT_BREAKER_OPEN',
        `project ${project.id} has ${queue.failureStreak} failed runs in a row — re-arm it before the autopilot starts another`,
      );
    }
    if (queue.running >= queue.cap) {
      throw new ConflictException(
        'AUTOPILOT_AT_CAP',
        `project ${project.id} is already running ${queue.running} of ${queue.cap} tasks`,
      );
    }
  }

  private async assertNotAlreadyRunning(
    task: Task,
    em: EntityManager,
  ): Promise<void> {
    if (task.runId === null) {
      return;
    }
    const run = await this.runDao.getById(task.runId, em);
    if (run && !isTerminalRunStatus(run.status)) {
      throw new ConflictException(
        'TASK_ALREADY_RUNNING',
        `task ${task.id} is already being worked by run ${task.runId}`,
      );
    }
  }

  private async require(taskId: string, em: EntityManager): Promise<Task> {
    const task = await this.taskDao.getById(taskId, em);
    if (!task) {
      throw new NotFoundException(
        'TASK_NOT_FOUND',
        `no task with id ${taskId}`,
      );
    }
    return task;
  }

  private async requireProject(
    projectId: string,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(projectId, em);
    if (!project) {
      throw new NotFoundException(
        'PROJECT_NOT_FOUND',
        `no project with id ${projectId}`,
      );
    }
    return project;
  }
}

/**
 * The files bound to a card, read off its own column for the prompt.
 *
 * Tolerant like every other read of this column: a malformed row degrades to
 * "no attachments" rather than to a path-shaped fragment the agent then tries
 * to open.
 */
function attachedFiles(task: Task): TaskFileWire[] {
  try {
    const parsed: unknown = JSON.parse(task.attachments);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((row) => {
      const result = TaskFileSchema.safeParse(row);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

/**
 * The card's identifier for the run row, or nothing at all.
 *
 * A SPREAD rather than a value, because both create inputs spell the field
 * `taskIdentifier?: string` — optional, not nullable, exactly as `taskId` is —
 * so a board that predates numbering says nothing rather than sending a null
 * the input has no shape for. `taskIdentifier` itself already answers null for
 * a card with no number or a project with no key.
 */
function identifierOf(
  task: Task,
  project: Project,
): { taskIdentifier?: string } {
  const identifier = taskIdentifier(project.taskKey, task.number);
  return identifier === null ? {} : { taskIdentifier: identifier };
}
