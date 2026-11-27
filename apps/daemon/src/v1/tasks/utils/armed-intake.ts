import type { Project } from '../../projects/entity/project.entity';
import type { TaskStatus } from '../tasks.types';

/** Whether a card in `status` is one an armed autopilot starts by itself. */
export function landsInArmedIntake(
  project: Pick<Project, 'autopilotEnabled' | 'autopilotIntakeStatus'>,
  status: TaskStatus,
): boolean {
  return project.autopilotEnabled && project.autopilotIntakeStatus === status;
}

/** Where a card waits with nothing starting it — `backlog`, unless that is the armed intake. */
export function quietColumn(
  project: Pick<Project, 'autopilotEnabled' | 'autopilotIntakeStatus'>,
): TaskStatus {
  return landsInArmedIntake(project, 'backlog') ? 'todo' : 'backlog';
}

/**
 * The columns a card can wait in. The intake column is a free choice in the
 * autopilot's settings, and moving a card to `done` would announce its work
 * FINISHED and have its worktree collected — so only these two are honoured
 * where a card is put back to wait.
 */
export const WAITING_COLUMNS: readonly TaskStatus[] = ['backlog', 'todo'];

/**
 * Whether an armed autopilot leaves a card whose run has finished alone in
 * `intake`. Only a waiting column hands such a card out again: the autopilot
 * starts from the intake column, and a finished card left in any other one would
 * have its brief sent into its thread on every tick.
 */
export function leavesFinishedCardsAlone(intake: TaskStatus): boolean {
  return !WAITING_COLUMNS.includes(intake);
}
