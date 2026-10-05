import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BaseException } from '@packages/common';
import type { z } from 'zod';

import type { ChatApprovalMode } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { isHostBoardTool } from '../../agents/utils/host-board';
import type { TaskBoardToolAnswer } from '../../graphs/graphs.types';
import { TaskBoardBroker } from '../../graphs/services/task-board.broker';
import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Project } from '../../projects/entity/project.entity';
import { isBreakerOpen } from '../../projects/utils/breaker';
import { taskIdentifier } from '../../projects/utils/project-key';
import { type AgentKind, AgentKindSchema } from '../../runs/runs.types';
import { TaskDao } from '../dao/task.dao';
import { createTaskSchema, updateTaskSchema } from '../dto/task.dto';
import type { Task } from '../entity/task.entity';
import {
  AUTOPILOT_PICKUP_SECONDS,
  BOARD_LIST_TASKS_DEFAULT_LIMIT,
  BOARD_LIST_TASKS_MAX_LIMIT,
  TASK_AGENT_OWN_STATUSES,
  TASK_REPORT_MAX,
  TASK_RUN_CONFIG_FIELDS,
  TASK_STATUSES,
  type TaskStatus,
  TaskStatusSchema,
  type TaskWire,
} from '../tasks.types';
import { BOARD_TOOLS, boardToolArgs } from '../utils/board-tools';
import { reportImagePaths, rewriteReportImages } from '../utils/report-images';
import { resolveRunTarget } from '../utils/run-target';
import { parseLabels } from '../utils/task-labels';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskBoardVocabularyService } from './task-board-vocabulary.service';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/**
 * The card fields `update_task` writes through `updateTaskSchema` — every
 * argument its schema lists except the ones that name, move or report.
 */
const UPDATE_FIELDS = boardToolArgs('update_task').filter(
  (arg) => !['task', 'status', 'fromStatus', 'report'].includes(arg),
);

/**
 * Fields of a card the board tools can READ and never write: the two ends of
 * the run<->task edge and the run's own record (`updateTaskSchema` explains
 * why), plus what identifies the card.
 */
const READ_ONLY_FIELDS = [
  'runId',
  'branch',
  'worktreePath',
  'reportedAt',
  'number',
  'key',
  'id',
  'projectId',
  'position',
  'source',
  'attachments',
  'pullRequests',
];

/**
 * A call that ends early with an answer — thrown inside a tool so each one
 * reads as a straight line, and caught once in {@link TaskBoardToolService.call}.
 */
class BoardAnswer extends Error {
  constructor(
    readonly text: string,
    readonly isError: boolean,
  ) {
    super(text);
  }
}

const invalid = (reason: string): BoardAnswer =>
  new BoardAnswer(`INVALID_ARGS: ${reason}`, true);

/**
 * The board's half of the board tools (`HOST_BOARD_TOOLS`) — how ANY agent
 * holding geniro's MCP endpoint reads the board and files or changes cards,
 * without learning the daemon's REST API.
 *
 * Every write goes through {@link TasksService}, so a card an agent changes is
 * validated, compare-and-set and announced on `task_changed` exactly like one
 * the user drags. A run that WORKS a card (`Run.taskId`) keeps the defaults it
 * always had: `get_task` / `update_task` target that card when no `task` is
 * named, it may only move it to {@link TASK_AGENT_OWN_STATUSES}, and its report's
 * screenshots are copied onto the card.
 *
 * Installed into {@link TaskBoardBroker} at boot, since the MCP host that
 * serves the tools lives in `GraphsModule`, which this module imports and which
 * may not import it back.
 */
@Injectable()
export class TaskBoardToolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TaskBoardToolService.name);
  private uninstall: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly broker: TaskBoardBroker,
    private readonly runDao: RunDao,
    private readonly taskDao: TaskDao,
    private readonly projectDao: ProjectDao,
    private readonly tasks: TasksService,
    private readonly attachments: TaskAttachmentService,
    private readonly files: TaskFilesService,
    private readonly workflows: WorkflowStoreService,
    private readonly vocabulary: TaskBoardVocabularyService,
  ) {}

  onModuleInit(): void {
    this.uninstall = this.broker.install({
      tools: () => BOARD_TOOLS,
      call: (runId, name, args) => this.call(runId, name, args),
    });
  }

  onModuleDestroy(): void {
    this.uninstall?.();
    this.uninstall = null;
  }

  async call(
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<TaskBoardToolAnswer> {
    try {
      return {
        text: await this.answer(runId, name, args),
        isError: false,
      };
    } catch (err) {
      if (err instanceof BoardAnswer) {
        return { text: err.text, isError: err.isError };
      }
      if (err instanceof BaseException) {
        return { text: `${err.errorCode}: ${err.message}`, isError: true };
      }
      throw err;
    }
  }

  private async answer(
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (!isHostBoardTool(name)) {
      throw invalid(`'${name}' is not a board tool`);
    }
    rejectUnknownArgs(args, boardToolArgs(name));
    switch (name) {
      case 'list_projects':
        return this.listProjects();
      case 'board_vocabulary':
        return this.boardVocabulary(args);
      case 'list_tasks':
        return this.listTasks(args);
      case 'get_task':
        return this.getTask(runId, args);
      case 'create_task':
        return this.createTask(runId, args);
      case 'update_task':
        return this.updateTask(runId, args);
    }
  }

  private async listProjects(): Promise<string> {
    const em = this.em.fork();
    const projects = await this.projectDao.listAll(em);
    if (projects.length === 0) {
      return 'There are no projects on the board yet — a person creates one in the app (Tasks → New project).';
    }
    const counts = new Map<string, Record<TaskStatus, number>>();
    for (const task of await this.taskDao.listBoardFacts(em)) {
      const byStatus = counts.get(task.projectId) ?? emptyCounts();
      byStatus[task.status] += 1;
      counts.set(task.projectId, byStatus);
    }
    const armed = projects.filter((project) => project.autopilotEnabled);
    const lead =
      `${projects.length} project${projects.length === 1 ? '' : 's'}. ` +
      (armed.length === 0
        ? 'No project has its autopilot armed.'
        : `Autopilot ARMED on: ${armed
            .map(
              (project) =>
                `${projectLabel(project)} (starts an agent on cards in \`${project.autopilotIntakeStatus}\`${
                  isBreakerOpen(project)
                    ? ' — currently paused by its failure breaker'
                    : ''
                })`,
            )
            .join(', ')}.`);
    return withJson(
      lead,
      projects.map((project) => ({
        id: project.id,
        key: project.taskKey,
        name: project.name,
        folder: project.folder,
        runConfiguration: projectRunConfig(project),
        autopilot: {
          armed: project.autopilotEnabled,
          intakeColumn: project.autopilotIntakeStatus,
          maxConcurrentRuns: project.autopilotMaxConcurrent,
          pausedByFailureBreaker: isBreakerOpen(project),
        },
        cards: counts.get(project.id) ?? emptyCounts(),
      })),
    );
  }

  private async boardVocabulary(
    args: Record<string, unknown>,
  ): Promise<string> {
    let agentKind: AgentKind | null = null;
    if (args.agentKind !== undefined) {
      const parsed = AgentKindSchema.safeParse(args.agentKind);
      if (!parsed.success) {
        throw invalid(`'agentKind': ${zodReason(parsed.error)}`);
      }
      agentKind = parsed.data;
    }
    if (
      args.model !== undefined &&
      (typeof args.model !== 'string' || args.model.trim() === '')
    ) {
      throw invalid("'model' must be a non-empty string");
    }
    if (args.model !== undefined && agentKind === null) {
      throw invalid(
        "'model' needs 'agentKind' — a model id belongs to one CLI",
      );
    }
    const model = typeof args.model === 'string' ? args.model.trim() : null;
    const vocabulary = await this.vocabulary.read(agentKind, model);
    return withJson(
      'Labels already on the board (a label with `instructionsFor` hands those instructions to every agent run on a card ' +
        'carrying it), saved workflows, the CLI agents (a null `version` means that CLI did not answer — it is probably ' +
        'not installed), and config directories already in use.' +
        (agentKind === null
          ? ' Pass `agentKind` to list that CLI’s model ids and effort levels.'
          : ''),
      vocabulary,
    );
  }

  private async listTasks(args: Record<string, unknown>): Promise<string> {
    const em = this.em.fork();
    const projects = await this.projectDao.listAll(em);
    const project =
      args.project === undefined
        ? null
        : resolveProject(args.project, projects);
    const statuses = readStatusFilter(args.status);
    const label = optionalText(args.label, 'label')?.toLowerCase() ?? null;
    const query = optionalText(args.query, 'query')?.toLowerCase() ?? null;
    const limit = readLimit(args.limit);
    const byId = new Map(projects.map((row) => [row.id, row]));

    const rows = (
      project === null
        ? await this.taskDao.listAll(em)
        : await this.taskDao.listForProject(project.id, em)
    )
      .filter((task) => statuses === null || statuses.includes(task.status))
      .filter(
        (task) =>
          label === null ||
          parseLabels(task.labels).some((own) => own.toLowerCase() === label),
      )
      .map((task) => ({ task, key: keyOf(task, byId.get(task.projectId)) }))
      .filter(
        ({ task, key }) =>
          query === null ||
          [key ?? '', task.title, task.description ?? ''].some((text) =>
            text.toLowerCase().includes(query),
          ),
      )
      .sort(
        (a, b) =>
          TASK_STATUSES.indexOf(a.task.status) -
            TASK_STATUSES.indexOf(b.task.status) ||
          a.task.position - b.task.position,
      );
    const shown = rows.slice(0, limit);
    const lead =
      rows.length === 0
        ? 'No card matches.'
        : `${rows.length} card${rows.length === 1 ? '' : 's'} match${rows.length === 1 ? 'es' : ''}` +
          (rows.length > shown.length
            ? `; showing the first ${shown.length} — narrow the filters or raise \`limit\`.`
            : '.');
    return withJson(
      lead,
      shown.map(({ task, key }) => ({
        key,
        id: task.id,
        project: projectLabel(byId.get(task.projectId)),
        title: task.title,
        status: task.status,
        priority: task.priority,
        labels: parseLabels(task.labels),
        dueDate: task.dueDate,
        hasRun: task.runId !== null,
        updatedAt: task.updatedAt.toISOString(),
      })),
    );
  }

  private async getTask(
    runId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const em = this.em.fork();
    const { task, own } = await this.target(runId, args.task, em);
    const view = await this.cardView(task.id, em, own);
    return withJson(
      `${view.key ?? 'The card'} is in \`${view.status}\`${own ? ' — it is the card this conversation is working' : ''}.`,
      view,
    );
  }

  private async createTask(
    runId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const em = this.em.fork();
    const project = resolveProject(
      args.project,
      await this.projectDao.listAll(em),
    );
    const fields = Object.fromEntries(
      Object.entries(args).filter(([key]) => key !== 'project'),
    );
    const parsed = createTaskSchema.safeParse({
      ...fields,
      projectId: project.id,
    });
    if (!parsed.success) {
      throw invalid(zodReason(parsed.error));
    }
    await this.requireWorkflow(parsed.data.workflowSlug);
    await this.refuseUnattended(runId, em, {
      project,
      landing: parsed.data.status ?? 'backlog',
      changesCard: false,
      approval: parsed.data.approval ?? null,
      changesRunConfig: false,
    });
    const created = await this.tasks.create(parsed.data);
    const view = await this.cardView(created.id, em, false);

    const notes = [
      `Created ${view.key ?? `card ${view.id}`} "${view.title}" in \`${view.status}\` on project ${projectLabel(project)}.`,
    ];
    notes.push(runTargetNote(created, project));
    notes.push(...startNotes(project, created.status));
    return withJson(notes.join(' '), view);
  }

  private async updateTask(
    runId: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const em = this.em.fork();
    const { task, own } = await this.target(runId, args.task, em);
    const project = await this.requireProjectOf(task, em);
    const label = keyOf(task, project) ?? `card ${task.id}`;

    const fields = Object.fromEntries(
      UPDATE_FIELDS.filter((field) => args[field] !== undefined).map(
        (field) => [field, args[field]],
      ),
    );
    let patch: z.infer<typeof updateTaskSchema> | null = null;
    if (Object.keys(fields).length > 0) {
      const parsed = updateTaskSchema.safeParse(fields);
      if (!parsed.success) {
        throw invalid(zodReason(parsed.error));
      }
      patch = parsed.data;
      await this.requireWorkflow(patch.workflowSlug ?? undefined);
    }

    const status = readStatus(args.status, 'status');
    const fromStatus = readStatus(args.fromStatus, 'fromStatus');
    if (fromStatus !== null && status === null) {
      throw invalid("'fromStatus' only means something together with 'status'");
    }
    if (
      own &&
      status !== null &&
      !(TASK_AGENT_OWN_STATUSES as readonly string[]).includes(status)
    ) {
      throw invalid(
        `the card this conversation is working may only move to ${TASK_AGENT_OWN_STATUSES.join(', ')} — ` +
          `\`${status}\` is the intake, and the autopilot would hand it straight back out`,
      );
    }
    const report = readReport(args.report);
    if (patch === null && status === null && report === null) {
      throw invalid(
        `nothing to change — pass at least one of ${[...UPDATE_FIELDS, 'status', 'report'].join(', ')}`,
      );
    }
    if (fromStatus !== null && task.status !== fromStatus) {
      throw new BoardAnswer(
        `Nothing changed: ${label} is in \`${task.status}\`, not \`${fromStatus}\` — it moved since you read it. ` +
          'Read it again with get_task and decide whether the change still applies.',
        false,
      );
    }

    const moves = status !== null && status !== task.status;
    // Keyed on where the card ENDS UP, not on whether it moves: a card already
    // waiting in an armed intake is handed to the autopilot as it stands, so
    // rewriting it there is the same start as moving it in.
    if (patch !== null || report !== null || moves) {
      await this.refuseUnattended(runId, em, {
        project,
        landing: moves ? status : null,
        // Any change to an existing card counts, except a run finishing the
        // card IT works — its report, and a move the landing check judges.
        changesCard: patch !== null || !own,
        approval: patch?.approval ?? null,
        changesRunConfig: TASK_RUN_CONFIG_FIELDS.some(
          (field) => patch?.[field] !== undefined,
        ),
      });
    }

    // The card's own fields first: their checks (a folder or config directory
    // that must exist) are the ones that can still refuse, and nothing has
    // been copied onto the card yet if they do.
    if (patch !== null) {
      await this.tasks.update(task.id, patch);
    }
    const notes: string[] = [];
    if (report !== null) {
      const { text, attached, skipped } = await this.adoptReportImages(
        task.id,
        report,
      );
      await this.tasks.update(task.id, { report: text });
      if (attached > 0) {
        notes.push(
          `${attached} image${attached === 1 ? '' : 's'} copied onto the card.`,
        );
      }
      if (skipped.length > 0) {
        notes.push(
          `Could not copy: ${skipped.join(', ')} — the report still references them.`,
        );
      }
    }
    const changed = [
      ...Object.keys(fields),
      ...(report === null ? [] : ['report']),
    ];

    let moved: TaskWire | null = null;
    if (moves) {
      try {
        moved = await this.tasks.moveStatus(task.id, {
          from: fromStatus ?? task.status,
          to: status,
        });
      } catch (err) {
        if (
          err instanceof BaseException &&
          err.errorCode === 'TASK_STATUS_CONFLICT'
        ) {
          throw new BoardAnswer(
            `${changed.length > 0 ? `Saved ${changed.join(', ')}, but did` : 'Did'} not move ${label}: ${err.message}.`,
            false,
          );
        }
        throw err;
      }
    }

    const done: string[] = [];
    if (changed.length > 0) {
      done.push(`changed ${changed.join(', ')}`);
    }
    if (moved !== null) {
      done.push(`moved \`${task.status}\` → \`${moved.status}\``);
    } else if (status !== null) {
      done.push(`it was already in \`${status}\``);
    }
    const lead = `Updated ${label}: ${done.join('; ')}`;
    notes.push(...startNotes(project, moved?.status ?? task.status));
    const view = await this.cardView(task.id, em, own);
    return withJson([`${lead}.`, ...notes].join(' '), view);
  }

  /**
   * Refuse what would hand an agent's own text to UNATTENDED work, when the
   * conversation asking is a chat in any approval mode but `auto`:
   *
   * - on a board whose autopilot is ARMED, putting a card in its intake column
   *   or changing an existing card at all. Column checks alone are not enough:
   *   a working card returns to the intake by itself when its run is
   *   interrupted or deleted, and is then started as it stands, with `auto`
   *   approval. The run working a card may still write its report and move it
   *   to a column that is not the intake;
   * - setting a card's approval to `auto`;
   * - changing an EXISTING card's run configuration at all — which agent,
   *   workflow, approval and profile a person's next Run press uses is decided
   *   as much by inheritance as by the value sent.
   *
   * The board tools are auto-approved in chats, so nothing else stands between
   * an agent in an `ask` or `plan` chat and that start. A chat already in
   * `auto` gains nothing it did not have, and a workflow node's board calls
   * are gated by that node's own approval mode. An open failure breaker does
   * not exempt an armed board — it only delays the start — while arming a
   * board is itself a person's act.
   */
  private async refuseUnattended(
    runId: string,
    em: EntityManager,
    write: {
      project: Project;
      /** The column the card is put in, or null when it is not moved. */
      landing: TaskStatus | null;
      /** Whether an existing card's own content changes. */
      changesCard: boolean;
      approval: ChatApprovalMode | null;
      changesRunConfig: boolean;
    },
  ): Promise<void> {
    const armed =
      write.project.autopilotEnabled &&
      (write.changesCard ||
        (write.landing !== null &&
          landsInArmedIntake(write.project, write.landing)));
    if (!armed && write.approval !== 'auto' && !write.changesRunConfig) {
      return;
    }
    const run = await this.runDao.getById(runId, em);
    if (run !== null && (run.workflowId !== null || run.approval === 'auto')) {
      return;
    }
    const mode =
      run?.approval == null
        ? 'is not running in `auto` approval'
        : `runs in \`${run.approval}\` approval`;
    if (armed) {
      throw new BoardAnswer(
        `Refused: project ${projectLabel(write.project)} has its autopilot ARMED — it starts cards in ` +
          `\`${write.project.autopilotIntakeStatus}\` as unattended work within about ${AUTOPILOT_PICKUP_SECONDS} ` +
          'seconds, and a working card returns there by itself if its run is interrupted — and this conversation ' +
          `${mode}, so it may not put a card in that intake or change existing cards on this board. Nothing was ` +
          `changed. File new cards in \`${quietColumn(write.project)}\` and tell the user what to change themselves.`,
        true,
      );
    }
    throw new BoardAnswer(
      write.approval === 'auto'
        ? `Refused: this conversation ${mode}, so it may not set a card's approval to \`auto\` — a person's next Run ` +
            'press would then start it unattended. Nothing was changed. Leave approval out (it inherits the ' +
            "project's) and tell the user if it should be `auto`."
        : `Refused: this conversation ${mode}, so it may not change an existing card's run configuration ` +
            `(${TASK_RUN_CONFIG_FIELDS.join(', ')}) — those decide whether a person's next Run press starts it ` +
            'unattended. Nothing was changed. Tell the user what to set, or change the other fields on their own.',
      true,
    );
  }

  private async cardView(taskId: string, em: EntityManager, own: boolean) {
    const wire = await this.tasks.get(taskId);
    const project = await this.projectDao.getById(wire.projectId, em);
    return {
      key: taskIdentifier(project?.taskKey ?? null, wire.number),
      id: wire.id,
      project:
        project === null
          ? null
          : { id: project.id, key: project.taskKey, name: project.name },
      title: wire.title,
      description: wire.description,
      status: wire.status,
      priority: wire.priority,
      labels: wire.labels,
      dueDate: wire.dueDate,
      sourceRef: wire.sourceRef,
      runConfiguration: Object.fromEntries(
        TASK_RUN_CONFIG_FIELDS.map((field) => [
          field,
          { card: wire[field], project: project?.[field] ?? null },
        ]),
      ),
      report: wire.report,
      reportedAt: wire.reportedAt,
      runId: wire.runId,
      branch: wire.branch,
      worktreePath: wire.worktreePath,
      attachments: wire.attachments.map(({ name, path }) => ({ name, path })),
      pullRequests: wire.pullRequests.map((pr) => pr.url),
      workedByThisConversation: own,
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
    };
  }

  /**
   * The card a call is about: the one named, or — when none is — the card this
   * run works. `own` says whether the target IS that card, which is what
   * narrows the columns it may be moved to.
   */
  private async target(
    runId: string,
    ref: unknown,
    em: EntityManager,
  ): Promise<{ task: Task; own: boolean }> {
    const held = await this.heldCard(runId, em);
    if (ref === undefined) {
      if (held === null) {
        throw invalid(
          "pass 'task' (a key like GEN-53, or an id) — this conversation is not working a card, so there is no default one",
        );
      }
      return { task: held, own: true };
    }
    const task = await this.resolveTask(ref, em);
    return { task, own: held?.id === task.id };
  }

  private async resolveTask(ref: unknown, em: EntityManager): Promise<Task> {
    if (typeof ref !== 'string' || ref.trim() === '') {
      throw invalid("'task' must be a card key like GEN-53, or a card id");
    }
    const value = ref.trim();
    const byKey = /^([A-Za-z0-9]+)-(\d+)$/.exec(value);
    if (byKey !== null) {
      const key = byKey[1]!.toUpperCase();
      const projects = (await this.projectDao.listAll(em)).filter(
        (project) => project.taskKey?.toUpperCase() === key,
      );
      const found = await this.taskDao.findByNumber(
        projects.map((project) => project.id),
        Number(byKey[2]),
        em,
      );
      if (found.length === 1) {
        return found[0]!;
      }
      if (found.length > 1) {
        throw invalid(
          `${value} names a card in ${found.length} projects that share the key ${key} — pass the card id instead (ids: ${found.map((task) => task.id).join(', ')})`,
        );
      }
    } else {
      const task = await this.taskDao.getById(value, em);
      if (task !== null) {
        return task;
      }
    }
    throw new BoardAnswer(
      `UNKNOWN_TASK: there is no card "${value}" — list_tasks finds cards by words, label or column.`,
      true,
    );
  }

  private async requireProjectOf(
    task: Task,
    em: EntityManager,
  ): Promise<Project> {
    const project = await this.projectDao.getById(task.projectId, em);
    if (project === null) {
      throw new BoardAnswer(
        `UNKNOWN_PROJECT: the card's project no longer exists.`,
        true,
      );
    }
    return project;
  }

  /** A workflow slug must name a workflow the library holds. */
  private async requireWorkflow(slug: string | undefined): Promise<void> {
    if (slug === undefined) {
      return;
    }
    const known = (await this.workflows.list()).map(
      (workflow) => workflow.slug,
    );
    if (!known.includes(slug)) {
      throw invalid(
        `'workflowSlug': no saved workflow "${slug}" — ${
          known.length === 0
            ? 'the library holds none'
            : `the workflows are ${known.join(', ')}`
        }`,
      );
    }
  }

  /**
   * Copy each screenshot a report references onto the card and point the
   * report at the copies — an agent's screenshot lives in a scratch directory
   * that is routinely reaped. One that cannot be copied never costs the report.
   */
  private async adoptReportImages(
    taskId: string,
    report: string,
  ): Promise<{ text: string; attached: number; skipped: string[] }> {
    const copies = new Map<string, string>();
    const skipped: string[] = [];
    for (const source of reportImagePaths(report)) {
      try {
        copies.set(source, await this.keepImage(taskId, source));
      } catch (error) {
        skipped.push(source);
        this.logger.warn(
          `could not attach ${source} to task ${taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      text: rewriteReportImages(report, copies),
      attached: copies.size,
      skipped,
    };
  }

  /**
   * Copy one referenced image onto the card, or reuse the copy an earlier
   * report already made.
   *
   * Every `report` replaces the last, so an agent routinely sends the same
   * screenshots twice; matching the card's existing files by name and size is
   * what keeps the card from listing each picture once per report. A path that
   * already IS one of the card's own copies (a report read back through
   * `get_task` and sent on) is kept as it is.
   */
  private async keepImage(taskId: string, source: string): Promise<string> {
    const files = (await this.tasks.get(taskId)).attachments;
    if (files.some((file) => file.path === source)) {
      return source;
    }
    const { size } = await stat(source);
    const existing = files.find(
      (file) => file.name === basename(source) && file.bytes === size,
    );
    if (existing !== undefined) {
      return existing.path;
    }
    const copy = await this.attachments.adopt(taskId, source);
    await this.files.attach(taskId, copy);
    return copy;
  }

  /**
   * The card a run works — only while that card still names this run, so an
   * older conversation cannot treat a card that has been started again as its
   * own.
   */
  private async heldCard(
    runId: string,
    em: EntityManager,
  ): Promise<Task | null> {
    const run = await this.runDao.getById(runId, em);
    if (!run?.taskId) {
      return null;
    }
    const task = await this.taskDao.getById(run.taskId, em);
    return task !== null && task.runId === runId ? task : null;
  }
}

function rejectUnknownArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  const readOnly = unknown.filter((key) => READ_ONLY_FIELDS.includes(key));
  if (readOnly.length > 0) {
    throw invalid(
      `${readOnly.map((key) => `'${key}'`).join(', ')} cannot be set by a tool — the run, branch, worktree, number and project of a card belong to the board`,
    );
  }
  throw invalid(
    `unknown argument${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => `'${key}'`).join(', ')} — this tool takes ${
      allowed.length === 0 ? 'no arguments' : allowed.join(', ')
    }`,
  );
}

function resolveProject(ref: unknown, projects: readonly Project[]): Project {
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw invalid(
      "'project' must be a project id, card key (e.g. GEN) or name — list_projects lists them",
    );
  }
  const value = ref.trim();
  const lower = value.toLowerCase();
  const byId = projects.find((project) => project.id === value);
  if (byId !== undefined) {
    return byId;
  }
  const matches = projects.filter(
    (project) => project.taskKey?.toLowerCase() === lower,
  );
  const named =
    matches.length > 0
      ? matches
      : projects.filter((project) => project.name.toLowerCase() === lower);
  if (named.length === 1) {
    return named[0]!;
  }
  if (named.length > 1) {
    throw invalid(
      `"${value}" names ${named.length} projects — pass the id of one: ${named.map((project) => `${project.name} (${project.id})`).join(', ')}`,
    );
  }
  throw new BoardAnswer(
    `UNKNOWN_PROJECT: there is no project "${value}". ${
      projects.length === 0
        ? 'The board has no projects yet — a person creates one in the app.'
        : `The projects are: ${projects.map((project) => `${projectLabel(project)} (id ${project.id})`).join(', ')}.`
    }`,
    true,
  );
}

function readStatus(value: unknown, name: string): TaskStatus | null {
  if (value === undefined) {
    return null;
  }
  const parsed = TaskStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid(`'${name}' must be one of ${TASK_STATUSES.join(', ')}`);
  }
  return parsed.data;
}

function readStatusFilter(value: unknown): TaskStatus[] | null {
  if (value === undefined) {
    return null;
  }
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => {
    const status = readStatus(entry, 'status');
    if (status === null) {
      throw invalid("'status' must list columns");
    }
    return status;
  });
}

function readReport(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid("'report' must be a non-empty markdown string");
  }
  if (value.length > TASK_REPORT_MAX) {
    throw invalid(
      `'report' exceeds ${TASK_REPORT_MAX} characters — shorten it`,
    );
  }
  return value;
}

function readLimit(value: unknown): number {
  if (value === undefined) {
    return BOARD_LIST_TASKS_DEFAULT_LIMIT;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > BOARD_LIST_TASKS_MAX_LIMIT
  ) {
    throw invalid(
      `'limit' must be a whole number from 1 to ${BOARD_LIST_TASKS_MAX_LIMIT}`,
    );
  }
  return value;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalid(`'${name}' must be a non-empty string`);
  }
  return value.trim();
}

/** Every zod issue as `'field': what is wrong`, enum issues naming the allowed values. */
function zodReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path === '' ? issue.message : `'${path}': ${issue.message}`;
    })
    .join('; ');
}

function keyOf(task: Task, project: Project | undefined | null): string | null {
  return taskIdentifier(project?.taskKey ?? null, task.number);
}

function projectLabel(project: Project | undefined | null): string {
  if (project === undefined || project === null) {
    return '(unknown project)';
  }
  return project.taskKey === null
    ? project.name
    : `${project.taskKey} (${project.name})`;
}

function projectRunConfig(project: Project) {
  return Object.fromEntries(
    TASK_RUN_CONFIG_FIELDS.map((field) => [field, project[field]]),
  );
}

/**
 * What a new card will run as, and which of it comes from the project — read
 * through `resolveRunTarget`, the same resolution a start uses, so the answer
 * cannot name a model or workflow the card will never run with.
 */
function runTargetNote(card: TaskWire, project: Project): string {
  const folder =
    card.folder === null ? `${project.folder} (from the project)` : card.folder;
  const target = resolveRunTarget([card, project]);
  if (target.kind === 'problem') {
    return (
      `Folder: ${folder}. Neither this card nor its project names an agent or a workflow, so it cannot be ` +
      'started until one is set (agentKind or workflowSlug).'
    );
  }
  const from = (
    field: Exclude<(typeof TASK_RUN_CONFIG_FIELDS)[number], 'folder'>,
  ) => (card[field] === null ? ' (from the project)' : '');
  if (target.kind === 'workflow') {
    return `It runs through workflow \`${target.workflowSlug}\`${from('workflowSlug')}, in folder ${folder}.`;
  }
  const trims = (['model', 'effort', 'approval', 'configDir'] as const).map(
    (field) =>
      target[field] === null
        ? `${field}=(not set)`
        : `${field}=${target[field]}${from(field)}`,
  );
  return `It runs on ${target.agentKind}${from('agentKind')}, in folder ${folder}, with ${trims.join(', ')}.`;
}

/** Whether a card in `status` is one an armed autopilot starts by itself. */
function landsInArmedIntake(project: Project, status: TaskStatus): boolean {
  return project.autopilotEnabled && project.autopilotIntakeStatus === status;
}

/** Where a card waits with nothing starting it — `backlog`, unless that is the armed intake. */
function quietColumn(project: Project): TaskStatus {
  return landsInArmedIntake(project, 'backlog') ? 'todo' : 'backlog';
}

/**
 * What the autopilot will do with a card now in `status` — the hazard, said
 * where it happened rather than left to the description alone.
 */
function startNotes(project: Project, status: TaskStatus): string[] {
  if (!landsInArmedIntake(project, status)) {
    return [];
  }
  return [
    isBreakerOpen(project)
      ? `Project ${projectLabel(project)} has its autopilot armed on \`${status}\`, but it is paused by its failure breaker, so this card starts as soon as a person re-arms it.`
      : `AUTOPILOT: project ${projectLabel(project)} is ARMED and takes work from \`${status}\` — it will start an agent on this card by itself within about ${AUTOPILOT_PICKUP_SECONDS} seconds (when one of its ${project.autopilotMaxConcurrent} run slots is free). Move the card to \`${quietColumn(project)}\` now if that is not what the user wants.`,
  ];
}

function emptyCounts(): Record<TaskStatus, number> {
  return Object.fromEntries(
    TASK_STATUSES.map((status) => [status, 0]),
  ) as Record<TaskStatus, number>;
}

function withJson(lead: string, value: unknown): string {
  return `${lead}\n\n${JSON.stringify(value, null, 2)}`;
}
