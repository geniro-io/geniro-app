import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import {
  HOST_START_THREAD_TOOL,
  type StartThreadAnswer,
  type StartThreadInput,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import { RunNoticeWriter } from '../../agents/services/run-notice.writer';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import { taskIdentifier } from '../../projects/utils/project-key';
import type { AgentKind } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { Task } from '../../tasks/entity/task.entity';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import { TaskRunsService } from '../../tasks/services/task-runs.service';
import { TasksService } from '../../tasks/services/tasks.service';
import type { ProjectRunStart } from '../../tasks/tasks.types';
import type {
  CommandCenterStart,
  CommandCenterThreadStartState,
} from '../command-center.types';
import { START_FAILURE_MAX_CHARS } from '../command-center.types';
import { CommandCenterThreadStartDao } from '../dao/command-center-thread-start.dao';
import type { CommandCenterThreadStart } from '../entity/command-center-thread-start.entity';
import { managerWake } from '../utils/manager-wake';
import { CommandCenterChatService } from './command-center-chat.service';
import { CommandCenterEventBus } from './command-center-events.bus';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The card id of one cardless start request, derivable from its row. */
function threadStartCardId(startId: string): string {
  return `command-center-start:thread:${startId}`;
}

/** What a cardless start's Start card is drawn from. */
export interface ThreadStartCardInput {
  startId: string;
  title: string;
  project: string;
  brief: string;
}

/** The card id of one start request, derivable from the task's own columns. */
function startCardId(taskId: string, requestedAt: Date): string {
  return `command-center-start:${taskId}:${requestedAt.getTime()}`;
}

function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The manager's starts: `start_thread` files a backlog card and records a
 * start request on it; the user's Start (or a manager chat in `auto`)
 * approves it; Electron main's drain prepares the worktree and starts the run
 * with `startedBy: 'manager'`; the manager is woken when it has started or
 * failed. The request lives on the task row, so a restart loses nothing: the
 * Start cards still waiting are tracked again at boot, and a start the
 * manager was not told about is told then.
 */
@Injectable()
export class CommandCenterStartsService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CommandCenterStartsService.name);
  private subscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly wakes: HostWakeBus,
    private readonly projectDao: ProjectDao,
    private readonly taskDao: TaskDao,
    private readonly tasks: TasksService,
    private readonly taskEvents: TaskEventBus,
    private readonly managers: CommandCenterChatService,
    private readonly notices: RunNoticeWriter,
    private readonly threadStarts: CommandCenterThreadStartDao,
    private readonly taskRuns: TaskRunsService,
    private readonly agents: AgentEventBus,
    private readonly events: CommandCenterEventBus,
  ) {}

  private deletions: Subscription | null = null;

  onModuleInit(): void {
    this.subscription = this.taskEvents.allChanges().subscribe(() => {
      void this.reportStarted();
    });
    this.deletions = this.agents.allDeleted().subscribe((runId) => {
      void this.threadStarts.deleteOf(runId).catch((error: unknown) => {
        this.logger.warn(
          `cardless starts of ${runId} not dropped with it: ${messageOf(error)}`,
        );
      });
    });
  }

  onApplicationBootstrap(): void {
    void this.rehydrate();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.deletions?.unsubscribe();
  }

  /**
   * `start_thread`: put the start to the user, or approve it in `auto`. With
   * `card` it files a backlog card first and the start lives on the card;
   * without, it is a row of its own and the thread runs in the project's folder.
   */
  async start(
    managerRunId: string,
    input: StartThreadInput,
  ): Promise<StartThreadAnswer> {
    const em = this.em.fork();
    const manager = await this.runDao.getById(managerRunId, em);
    if (manager === null || manager.commandCenter !== true) {
      return {
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: 'only the command center manager starts threads',
      };
    }
    const project = this.projectNamed(
      await this.projectDao.listAll(em),
      input.project,
    );
    if (project === null) {
      return {
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: `no project has the id or name "${input.project}"`,
      };
    }
    if (!input.card) {
      return this.startWithoutCard(
        managerRunId,
        manager.approval === 'auto',
        project,
        input,
      );
    }
    const task = await this.tasks.create({
      projectId: project.id,
      title: input.title,
      description: input.brief,
      status: 'backlog',
      ...(input.agent === undefined
        ? {}
        : { agentKind: input.agent as AgentKind }),
      ...(input.team === undefined ? {} : { teamSlug: input.team }),
    });
    const requestedAt = new Date();
    const auto = manager.approval === 'auto';
    await this.taskDao.setStartRequest(
      task.id,
      {
        requestedAt,
        byRunId: managerRunId,
        approvedAt: auto ? requestedAt : null,
        note: input.note?.trim() ? input.note.trim() : null,
        watch: input.watch,
      },
      em,
    );
    this.tasks.announceInPlace(task);
    const identifier = taskIdentifier(project.taskKey, task.number);
    if (auto) {
      return { status: 'starting', taskId: task.id, identifier };
    }
    try {
      await this.chats.raiseOwnedCard(
        managerRunId,
        startCardId(task.id, requestedAt),
        this.cardOf(task.id, input.title, project.name, input.brief),
        this.responderFor(managerRunId, task.id, input.title),
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} could not put a Start card on screen: ${messageOf(error)}`,
      );
      await this.taskDao.setStartRequest(task.id, null, em);
      this.tasks.announceInPlace(task);
      return {
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        reason: `the card ${identifier ?? task.id} was filed in backlog, but its Start card could not be shown`,
        failure: 'internal',
      };
    }
    return { status: 'card_shown', taskId: task.id, identifier };
  }

  /** Every approved start not yet started, for Electron main's drain. */
  async approvedStarts(): Promise<CommandCenterStart[]> {
    const em = this.em.fork();
    const [tasks, threads] = await Promise.all([
      this.taskDao.listApprovedStarts(em),
      this.threadStarts.listApproved(),
    ]);
    if (tasks.length === 0 && threads.length === 0) {
      return [];
    }
    const projects = new Map(
      (await this.projectDao.listAll(em)).map((project) => [
        project.id,
        project,
      ]),
    );
    const cardless = threads.flatMap((row): CommandCenterStart[] => {
      const project = projects.get(row.projectId);
      return project === undefined
        ? []
        : [
            {
              kind: 'thread',
              startId: row.id,
              projectId: row.projectId,
              title: row.title,
              folder: project.folder,
              startedBy: 'manager',
            },
          ];
    });
    return tasks
      .flatMap((task): CommandCenterStart[] => {
        const project = projects.get(task.projectId);
        return project === undefined
          ? []
          : [
              {
                kind: 'card',
                taskId: task.id,
                projectId: task.projectId,
                title: task.title,
                status: task.status,
                folder: task.folder ?? project.folder,
                startedBy:
                  task.startRequestKind === 'analysis' ? 'user' : 'manager',
              },
            ];
      })
      .concat(cardless);
  }

  /** Where a cardless start stands, for its Start card. */
  async threadStartState(
    startId: string,
  ): Promise<CommandCenterThreadStartState> {
    const row = await this.threadStarts.read(startId);
    if (row === null) {
      throw new NotFoundException('START_NOT_FOUND', `no start ${startId}`);
    }
    return {
      startId,
      state:
        row.runId !== null
          ? 'started'
          : row.failedAt !== null
            ? 'failed'
            : row.declinedAt !== null
              ? 'declined'
              : row.approvedAt !== null
                ? 'approved'
                : 'waiting',
      runId: row.runId,
      failure: row.failure,
    };
  }

  /**
   * The drain starts an approved cardless request: a chat or team run in the
   * project's folder with the user's run settings, then the manager hears it
   * started and the thread joins its roster. A request another drain took, or
   * one not approved, is refused `START_TAKEN`.
   */
  async startThreadRun(
    startId: string,
    settings: Omit<
      ProjectRunStart,
      'projectId' | 'title' | 'prompt' | 'target' | 'startedBy'
    >,
  ): Promise<CommandCenterThreadStartState> {
    const row = await this.threadStarts.read(startId);
    if (row === null) {
      throw new NotFoundException('START_NOT_FOUND', `no start ${startId}`);
    }
    if (!(await this.threadStarts.claim(startId, new Date()))) {
      throw new ConflictException(
        'START_TAKEN',
        `start ${startId} is not waiting to be started`,
      );
    }
    let runId: string;
    try {
      ({ runId } = await this.taskRuns.startProjectRun({
        ...settings,
        projectId: row.projectId,
        title: row.title,
        prompt: row.brief,
        target: {
          agentKind: row.agentKind as AgentKind | null,
          teamSlug: row.teamSlug,
        },
        startedBy: 'manager',
      }));
    } catch (error) {
      await this.threadStarts.release(startId);
      throw error;
    }
    await this.threadStarts.recordRun(startId, runId);
    this.events.publishChanged([row.managerRunId], 'start');
    await this.reportThread({ ...row, runId });
    return this.threadStartState(startId);
  }

  /** The drain could not start it: the request ends and the manager is told why. */
  async failed(startId: string, reason: string): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(startId, em);
    if (task === null) {
      await this.threadFailed(startId, reason);
      return;
    }
    const taskId = startId;
    if (task.startRequestedByRunId === null) {
      return;
    }
    const managerRunId = task.startRequestedByRunId;
    await this.taskDao.setStartRequest(taskId, null, em);
    await this.taskDao.clearStartRequester(taskId, em);
    this.tasks.announceInPlace(task);
    const said = reason.slice(0, START_FAILURE_MAX_CHARS);
    if (task.startRequestKind === 'analysis') {
      this.taskEvents.publishStartFailed({
        taskId,
        byRunId: managerRunId,
        title: task.title,
        reason: said,
      });
      return;
    }
    this.wakes.publish(
      managerWake(
        managerRunId,
        `start-failed:${taskId}`,
        `[command center] The thread "${task.title}" (card ${taskId}) could not be started: ${said}. The card stays in backlog; tell the user, or try again with start_thread once the cause is fixed.`,
        `Could not start "${task.title}"`,
      ),
    );
  }

  private async threadFailed(startId: string, reason: string): Promise<void> {
    const row = await this.threadStarts.read(startId);
    const said = reason.slice(0, START_FAILURE_MAX_CHARS);
    if (
      row === null ||
      !(await this.threadStarts.fail(startId, new Date(), said))
    ) {
      return;
    }
    this.events.publishChanged([row.managerRunId], 'start');
    this.wakes.publish(
      managerWake(
        row.managerRunId,
        `start-failed:${startId}`,
        `[command center] The thread "${row.title}" could not be started: ${said}. Nothing was started; tell the user, or try again with start_thread once the cause is fixed.`,
        `Could not start "${row.title}"`,
      ),
    );
  }

  private async startWithoutCard(
    managerRunId: string,
    auto: boolean,
    project: Project,
    input: StartThreadInput,
  ): Promise<StartThreadAnswer> {
    const requestedAt = new Date();
    const row = await this.threadStarts.create({
      managerRunId,
      projectId: project.id,
      title: input.title,
      brief: input.brief,
      agentKind: input.agent ?? null,
      teamSlug: input.team ?? null,
      note: input.note?.trim() ? input.note.trim() : null,
      watch: input.watch,
      requestedAt,
      approvedAt: auto ? requestedAt : null,
    });
    this.events.publishChanged([managerRunId], 'start');
    if (auto) {
      return { status: 'starting', startId: row.id };
    }
    try {
      await this.chats.raiseOwnedCard(
        managerRunId,
        threadStartCardId(row.id),
        this.threadCardOf(row, project.name),
        this.threadResponderFor(managerRunId, row.id, row.title),
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} could not put a Start card on screen: ${messageOf(error)}`,
      );
      await this.threadStarts.fail(
        row.id,
        new Date(),
        'its Start card could not be shown',
      );
      this.events.publishChanged([managerRunId], 'start');
      return {
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        reason: 'the Start card could not be shown; nothing was started',
        failure: 'internal',
      };
    }
    return { status: 'card_shown', startId: row.id };
  }

  private threadCardOf(
    row: Pick<CommandCenterThreadStart, 'id' | 'title' | 'brief'>,
    project: string,
  ): { toolName: string; input: ThreadStartCardInput } {
    return {
      toolName: HOST_START_THREAD_TOOL,
      input: { startId: row.id, title: row.title, project, brief: row.brief },
    };
  }

  private threadResponderFor(
    managerRunId: string,
    startId: string,
    title: string,
  ) {
    return (allow: boolean, answer?: string): void => {
      this.carryOutThreadVerdict(
        managerRunId,
        startId,
        title,
        allow,
        answer,
      ).catch((error: unknown) => {
        this.logger.error(
          `run ${managerRunId} Start card verdict for ${startId} not carried out: ${messageOf(error)}`,
        );
      });
    };
  }

  private async carryOutThreadVerdict(
    managerRunId: string,
    startId: string,
    title: string,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    const now = new Date();
    const carried = allow
      ? await this.threadStarts.approve(startId, now)
      : await this.threadStarts.decline(startId, now);
    this.events.publishChanged([managerRunId], 'start');
    const message = !carried
      ? `[command center] The Start card for "${title}" was answered, but it no longer asks to start; nothing was started.`
      : allow
        ? `[command center] The user approved starting "${title}". It is starting now; you are told when it has.`
        : `[command center] The user declined to start "${title}". Nothing was started.`;
    const note = answer?.trim() ?? '';
    try {
      await this.chats.deliverOwnedCardVerdict(
        managerRunId,
        threadStartCardId(startId),
        allow && carried,
        note === '' ? message : `${message}\nThe user's note: ${note}`,
        answer,
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} Start card verdict not delivered: ${messageOf(error)}`,
      );
    }
  }

  /** Put a started cardless thread on its manager's roster and tell the manager, once. */
  private async reportThread(
    row: Pick<
      CommandCenterThreadStart,
      'id' | 'managerRunId' | 'title' | 'note' | 'watch'
    > & { runId: string },
  ): Promise<void> {
    await this.managers.addToRoster(
      row.managerRunId,
      [row.runId],
      'manager',
      row.note,
      row.watch,
    );
    await this.threadStarts.markReported(row.id, new Date());
    await this.notices.info(row.managerRunId, `Started "${row.title}"`);
  }

  private projectNamed(
    projects: readonly Project[],
    name: string,
  ): Project | null {
    const byId = projects.find((project) => project.id === name.trim());
    if (byId !== undefined) {
      return byId;
    }
    const byName = projects.filter(
      (project) => folded(project.name) === folded(name),
    );
    return byName.length === 1 ? (byName[0] ?? null) : null;
  }

  private cardOf(
    taskId: string,
    title: string,
    project: string,
    brief: string,
  ): { toolName: string; input: unknown } {
    return {
      toolName: HOST_START_THREAD_TOOL,
      input: { taskId, title, project, brief },
    };
  }

  private responderFor(managerRunId: string, taskId: string, title: string) {
    return (allow: boolean, answer?: string): void => {
      this.carryOutVerdict(managerRunId, taskId, title, allow, answer).catch(
        (error: unknown) => {
          this.logger.error(
            `run ${managerRunId} Start card verdict for ${taskId} not carried out: ${messageOf(error)}`,
          );
        },
      );
    };
  }

  private async carryOutVerdict(
    managerRunId: string,
    taskId: string,
    title: string,
    allow: boolean,
    answer: string | undefined,
  ): Promise<void> {
    const em = this.em.fork();
    const task = await this.taskDao.getById(taskId, em);
    const requestedAt = task?.startRequestedAt ?? null;
    let message: string;
    if (task === null || requestedAt === null) {
      message = `[command center] The Start card for "${title}" was answered, but its card is gone or no longer asks to start; nothing was started.`;
    } else if (allow) {
      await this.taskDao.approveStartRequest(taskId, new Date(), em);
      this.tasks.announceInPlace(task);
      message = `[command center] The user approved starting "${title}". It is starting now; you are told when it has.`;
    } else {
      await this.taskDao.setStartRequest(taskId, null, em);
      await this.taskDao.clearStartRequester(taskId, em);
      this.tasks.announceInPlace(task);
      message = `[command center] The user declined to start "${title}". The card stays in backlog.`;
    }
    const note = answer?.trim() ?? '';
    try {
      await this.chats.deliverOwnedCardVerdict(
        managerRunId,
        requestedAt === null
          ? `command-center-start:${taskId}`
          : startCardId(taskId, requestedAt),
        allow && requestedAt !== null,
        note === '' ? message : `${message}\nThe user's note: ${note}`,
        answer,
      );
    } catch (error) {
      this.logger.error(
        `run ${managerRunId} Start card verdict not delivered: ${messageOf(error)}`,
      );
    }
  }

  /** Tell each manager about the threads it asked for that have started. */
  private async reportStarted(): Promise<void> {
    try {
      const em = this.em.fork();
      for (const task of await this.taskDao.listStartedForManager(em)) {
        await this.reportOne(task);
      }
    } catch (error) {
      this.logger.warn(`manager starts not reported: ${messageOf(error)}`);
    }
  }

  private async reportOne(task: Task): Promise<void> {
    const managerRunId = task.startRequestedByRunId;
    if (managerRunId === null || task.runId === null) {
      return;
    }
    const em = this.em.fork();
    if (!(await this.taskDao.claimStartReport(task.id, managerRunId, em))) {
      return;
    }
    try {
      await this.managers.addToRoster(
        managerRunId,
        [task.runId],
        'manager',
        task.startRequestNote,
        task.startRequestWatch,
      );
    } catch (error) {
      await this.taskDao.releaseStartReport(task.id, managerRunId, em);
      throw error;
    }
    await this.notices.info(managerRunId, `Started "${task.title}"`);
  }

  /** Track every Start card still waiting again, and tell what a restart left untold. */
  private async rehydrate(): Promise<void> {
    try {
      const em = this.em.fork();
      for (const task of await this.taskDao.listPendingStartRequests(em)) {
        const managerRunId = task.startRequestedByRunId;
        const requestedAt = task.startRequestedAt;
        if (
          managerRunId === null ||
          requestedAt === null ||
          task.startRequestKind === 'analysis'
        ) {
          continue;
        }
        const cardId = startCardId(task.id, requestedAt);
        const closed =
          (
            await this.itemDao.rowsByPayloadId(
              managerRunId,
              ['approval_verdict', 'unanswerable'],
              [cardId],
              undefined,
              em,
            )
          ).length > 0;
        if (closed) {
          await this.taskDao.setStartRequest(task.id, null, em);
          await this.taskDao.clearStartRequester(task.id, em);
          this.tasks.announceInPlace(task);
          continue;
        }
        const project = await this.projectDao.getById(task.projectId, em);
        this.chats.trackOwnedCard(
          managerRunId,
          cardId,
          this.cardOf(
            task.id,
            task.title,
            project?.name ?? '',
            task.description ?? '',
          ),
          this.responderFor(managerRunId, task.id, task.title),
        );
      }
      await this.rehydrateThreadStarts();
      await this.reportStarted();
    } catch (error) {
      this.logger.error(`Start card rehydration failed: ${messageOf(error)}`);
    }
  }

  private async rehydrateThreadStarts(): Promise<void> {
    const em = this.em.fork();
    const projects = new Map(
      (await this.projectDao.listAll(em)).map((project) => [
        project.id,
        project,
      ]),
    );
    for (const row of await this.threadStarts.listWaiting()) {
      const cardId = threadStartCardId(row.id);
      const closed =
        (
          await this.itemDao.rowsByPayloadId(
            row.managerRunId,
            ['approval_verdict', 'unanswerable'],
            [cardId],
            undefined,
            em,
          )
        ).length > 0;
      if (closed) {
        await this.threadStarts.fail(
          row.id,
          new Date(),
          'its Start card was closed before it was answered',
        );
        continue;
      }
      this.chats.trackOwnedCard(
        row.managerRunId,
        cardId,
        this.threadCardOf(row, projects.get(row.projectId)?.name ?? ''),
        this.threadResponderFor(row.managerRunId, row.id, row.title),
      );
    }
    for (const row of await this.threadStarts.listInterrupted()) {
      await this.threadFailed(
        row.id,
        'the app stopped while it was being started',
      );
    }
    for (const row of await this.threadStarts.listUnreported()) {
      if (row.runId !== null) {
        await this.reportThread({ ...row, runId: row.runId });
      }
    }
  }
}
