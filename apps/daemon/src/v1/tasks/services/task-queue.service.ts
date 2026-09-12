import { Injectable } from '@nestjs/common';

import { WorkflowStoreService } from '../../graphs/services/workflow-store.service';
import type {
  BlockedTask,
  ProjectQueue,
  QueuedTask,
} from '../../projects/projects.types';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import {
  isRunTargetProblem,
  resolveRunTarget,
  RUN_TARGET_PROBLEM_REASON,
} from '../utils/run-target';

/**
 * Why a card naming a workflow the library no longer holds cannot be started.
 *
 * `RunTargetProblem` / `RUN_TARGET_PROBLEM_REASON` / `RUN_TARGET_PROBLEM_CODE`
 * live in `tasks.types.ts` and `utils/run-target.ts`, and neither is this
 * service's to widen: `resolveRunTarget` answers purely from the levels it is
 * handed (a task, a project) and has no way to ask the workflow LIBRARY
 * whether a slug still exists — only a caller that also holds
 * `WorkflowStoreService` can ask that, which is exactly why this check lives
 * here rather than in `resolveRunTarget` itself. So it is its own named
 * export rather than a third member of that record.
 *
 * A function rather than a bare string, because the sentence has to NAME the
 * missing slug — a user reading "cannot run unattended" about a card whose
 * workflow no longer exists would go looking for the wrong fix (repointing it
 * at an agent, when picking a different, real workflow is just as available).
 */
export function missingWorkflowReason(slug: string): string {
  return `its workflow "${slug}" no longer exists in the library — point this task at a different workflow, or an agent`;
}

/**
 * Splits a project's waiting cards into what the autopilot may start now and
 * what it cannot, joining `ProjectQueueService`'s raw read against the
 * workflow library.
 *
 * That join is the whole reason this service exists rather than the split
 * staying inside `ProjectQueueService`: a card's run target can name a
 * WORKFLOW, and whether that workflow still exists is a question only
 * `WorkflowStoreService` (owned by `GraphsModule`) can answer.
 * `ProjectsModule` cannot import `GraphsModule` without reintroducing the
 * cycle its own module doc already refuses (`TasksModule` imports
 * `ProjectsModule`, never the reverse) — but `TasksModule` already imports
 * BOTH `ProjectsModule` and `GraphsModule`, so the join belongs here.
 */
@Injectable()
export class TaskQueueService {
  constructor(
    private readonly projectQueue: ProjectQueueService,
    private readonly workflows: WorkflowStoreService,
  ) {}

  async read(projectId: string): Promise<ProjectQueue> {
    const raw = await this.projectQueue.readRaw(projectId);
    // One listing for the whole batch rather than a `get()` per card:
    // `WorkflowStoreService.get()` THROWS `NotFoundException` for a slug that
    // is not in the library, so per-card would mean a try/catch around every
    // workflow-targeted waiting task instead of one Set membership check.
    const library = new Set(
      (await this.workflows.list()).map((summary) => summary.slug),
    );

    // Split BEFORE the cap is applied, so a blocked card cannot occupy one of
    // the slots the handout is narrowed to — otherwise a project with a cap of
    // one and a misconfigured card at the head of the column would starve
    // every runnable card behind it, which is the loop from the other side.
    const startable: typeof raw.waitingTasks = [];
    const blocked: BlockedTask[] = [];
    for (const task of raw.waitingTasks) {
      // The same resolution the start route performs, asked here so the
      // conductor never cuts a worktree for a run that will be refused. It
      // reads the two rows the route reads and nothing else, which is what
      // keeps the two answers the same — a second, looser predicate here would
      // hand out work the route then declines, restoring the churn.
      // Asked as whoever will ACTUALLY press Run on this board. While the
      // autopilot is armed that is the timer, and the refusals that apply only
      // to an unattended run belong in `blocked` — otherwise the conductor goes
      // on cutting a worktree per tick for a card the route then declines. On a
      // DISARMED board nothing unattended will start, so asking as the autopilot
      // would report the whole intake column of a workflow-targeted project as
      // unstartable when a hand press starts every card in it.
      // The USER arm is resolved whatever the board's state, because it is the
      // only one that keeps a workflow target INTACT: under 'autopilot' every
      // workflow-named card collapses to 'workflow-unattended' and the slug is
      // discarded with it, so this is the only place the library can be asked
      // about that slug at all.
      const asUser = resolveRunTarget([task, raw], 'user');
      // A slug the library no longer holds is broken in BOTH states, which is
      // why this is asked AHEAD of the armed/disarmed split rather than inside
      // it. On an armed board it is the churn loop; on a disarmed one a hand
      // press cuts a worktree and then 404s WORKFLOW_NOT_FOUND — the same dead
      // end, reached by the only door left open there.
      //
      // It also OUTRANKS 'workflow-unattended': a user told "cannot run
      // unattended" about a card whose workflow is gone goes looking for the
      // wrong fix — repointing it at an agent, when picking a different, real
      // workflow is just as available.
      if (
        !isRunTargetProblem(asUser) &&
        asUser.kind === 'workflow' &&
        !library.has(asUser.workflowSlug)
      ) {
        blocked.push({
          id: task.id,
          title: task.title,
          reason: missingWorkflowReason(asUser.workflowSlug),
        });
        continue;
      }
      const resolution = raw.enabled
        ? resolveRunTarget([task, raw], 'autopilot')
        : asUser;
      if (isRunTargetProblem(resolution)) {
        blocked.push({
          id: task.id,
          title: task.title,
          reason: RUN_TARGET_PROBLEM_REASON[resolution.reason],
        });
        continue;
      }
      startable.push(task);
    }

    return {
      projectId: raw.projectId,
      enabled: raw.enabled,
      intakeStatus: raw.intakeStatus,
      cap: raw.cap,
      running: raw.running,
      waiting: raw.waiting,
      breakerOpen: raw.breakerOpen,
      failureStreak: raw.failureStreak,
      eligible: raw.handOutWork
        ? startable
            .slice()
            .sort((a, b) => a.position - b.position)
            .slice(0, raw.freeSlots)
            .map((task) => toQueued(task, raw.folder))
        : [],
      // Reported whatever the autopilot's own state: a card that names no agent
      // is broken while the project is disarmed too, and a user who switches
      // autopilot on to find out why nothing happens has been told nothing.
      blocked,
      active: raw.active,
    };
  }
}

function toQueued(
  task: {
    id: string;
    title: string;
    status: QueuedTask['status'];
    position: number;
    folder: string | null;
  },
  projectFolder: string,
): QueuedTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    position: task.position,
    // The inheritance is resolved HERE and nowhere downstream: the conductor
    // runs in the Electron process off this handout alone, and a second copy
    // of "null means the project's" is how the timer and the board come to cut
    // worktrees from two different repositories.
    folder: task.folder ?? projectFolder,
  };
}
