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
