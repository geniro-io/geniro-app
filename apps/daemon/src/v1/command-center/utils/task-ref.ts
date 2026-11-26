import type { Task } from '../../tasks/entity/task.entity';
import type { CommandCenterTaskRef } from '../command-center.types';

export function cardsByRun(tasks: readonly Task[]): Map<string, Task> {
  return new Map(
    tasks.flatMap((task) =>
      task.runId === null ? [] : [[task.runId, task] as const],
    ),
  );
}

export function taskRefOf(
  run: { taskIdentifier: string | null },
  task: Task | null,
): CommandCenterTaskRef | null {
  return task === null
    ? null
    : {
        id: task.id,
        identifier: run.taskIdentifier,
        title: task.title,
        status: task.status,
      };
}
