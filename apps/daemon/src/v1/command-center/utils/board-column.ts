import type { RunWire } from '../../agents/chat.types';
import type { TaskStatus } from '../../tasks/tasks.types';
import type { CommandCenterColumn } from '../command-center.types';

type BoardRun = Pick<
  RunWire,
  | 'status'
  | 'awaiting'
  | 'outcome'
  | 'pullRequests'
  | 'holdingFor'
  | 'shellsOpen'
  | 'subagentsOut'
>;

function heldForWork(run: BoardRun): boolean {
  return (run.holdingFor ?? 0) > 0 || (run.subagentsOut ?? 0) > 0;
}

function commandRunning(run: BoardRun): boolean {
  return (run.shellsOpen ?? 0) > 0;
}

/**
 * The board column a thread sits in. In order: waiting on the user; working
 * (its run is running, or it settled while a turn it holds or a background
 * sub-agent it started is still out); done (its card is Done or the thread
 * recorded how it ended); working (it settled while a detached command it
 * started still runs, and it is not done); in review (its card is In review,
 * or it opened a pull request); idle. A thread with no card is placed by its
 * pull requests and outcome alone. A monitor does not make a thread working:
 * the chat list names that state `monitoring`, not `working`.
 */
export function boardColumnOf(
  run: BoardRun,
  taskStatus: TaskStatus | null,
): CommandCenterColumn {
  if (run.awaiting !== null) {
    return 'waiting';
  }
  if (
    run.status === 'running' ||
    (run.status === 'completed' && heldForWork(run))
  ) {
    return 'working';
  }
  if (taskStatus === 'done' || run.outcome !== null) {
    return 'done';
  }
  if (run.status === 'completed' && commandRunning(run)) {
    return 'working';
  }
  if (
    taskStatus === 'in_review' ||
    run.pullRequests.some((pullRequest) => pullRequest.opened)
  ) {
    return 'in_review';
  }
  return 'idle';
}
