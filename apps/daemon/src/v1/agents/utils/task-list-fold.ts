import type { RunTaskGroup, RunTaskRow, TaskStatus } from '../chat.types';

/**
 * The agent's own task list, folded from the announcements a run has written.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/task-payload.ts` reads the SAME
 * `task_list` payload shape and applies the SAME fold, because the transcript
 * still renders the list moving announcement by announcement. An item payload is
 * `z.unknown()` on the wire by design — every kind carries a different shape — so
 * no generated type spans this seam. A key renamed on either side must be
 * renamed on both.
 *
 * Why the daemon folds it AT ALL, given the renderer already does: the renderer
 * can only fold what its loaded WINDOW holds. Neither shipped CLI re-states the
 * whole list — measured 2026-08-31 on real turns, claude sent fifteen patches
 * naming one task each and no snapshot whatsoever, cursor sent one snapshot then
 * patches naming one or two rows — so the complete list exists only in the
 * EARLIEST announcements. `listRunItems` loads the newest `HISTORY_PAGE` items,
 * and past that the opening announcement is gone: folding the tail of that same
 * cursor run yields `3/3` and `4/4` where the truth is `2/6`, a total that
 * SHRANK. The run row is the only thing a cold window can read, which is exactly
 * why `Run.contextTokens` exists beside it.
 */

const STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

function readStatus(value: unknown): TaskStatus | null {
  return typeof value === 'string' && STATUSES.has(value as TaskStatus)
    ? (value as TaskStatus)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One announcement, as one `task_list` item payload carries it. */
export interface TaskAnnouncement {
  /** `snapshot` replaces the list; `patch` moves only the rows it names. */
  mode: 'snapshot' | 'patch';
  tasks: RunTaskRow[];
}

/** Read one `task_list` payload, or null when it does not read as one. */
export function readTaskAnnouncement(
  payload: unknown,
): TaskAnnouncement | null {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const row = payload as { mode?: unknown; tasks?: unknown };
  if (!Array.isArray(row.tasks)) {
    return null;
  }
  const tasks = row.tasks
    .map((entry): RunTaskRow | null => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }
      const task = entry as {
        id?: unknown;
        title?: unknown;
        status?: unknown;
        activeForm?: unknown;
      };
      const id = readString(task.id);
      return id === null
        ? null
        : {
            id,
            title: readString(task.title),
            status: readStatus(task.status),
            activeForm: readString(task.activeForm),
          };
    })
    .filter((task): task is RunTaskRow => task !== null);
  return {
    // A payload whose mode is missing or unrecognised reads as a PATCH — the
    // direction that fails safely, exactly as the renderer's twin states it: a
    // snapshot mistaken for a patch leaves a stale row on screen, while a patch
    // mistaken for a snapshot deletes every task it did not name.
    mode: row.mode === 'snapshot' ? 'snapshot' : 'patch',
    tasks,
  };
}

/**
 * Apply one announcement to the list so far.
 *
 * A patch MERGES per field rather than replacing the row: claude's `TaskUpdate`
 * sends `{taskId, status}` and no text at all, so a replacing merge would blank
 * the title of every task the moment it started running.
 */
function applyAnnouncement(
  list: readonly RunTaskRow[],
  announcement: TaskAnnouncement,
): RunTaskRow[] {
  if (announcement.mode === 'snapshot') {
    return announcement.tasks.map((task) => {
      const known = list.find((row) => row.id === task.id);
      return {
        ...task,
        title: task.title ?? known?.title ?? null,
        activeForm: task.activeForm ?? known?.activeForm ?? null,
      };
    });
  }
  const merged = [...list];
  for (const task of announcement.tasks) {
    const at = merged.findIndex((row) => row.id === task.id);
    if (at === -1) {
      merged.push(task);
      continue;
    }
    const known = merged[at]!;
    merged[at] = {
      id: known.id,
      title: task.title ?? known.title,
      // The status IS what a patch is for, so a patch that named the task takes
      // it even when it is null — the CLI moved this row somewhere we could not
      // name, which is not the same as it standing still.
      status: task.status,
      activeForm: task.activeForm ?? known.activeForm,
    };
  }
  return merged;
}

/**
 * Fold every announcement a run has written into one list per AGENT.
 *
 * Keyed by `nodeId` (null for a 1:1 chat's one agent) for the reason the
 * renderer's `taskListsByAgent` is: a delegate's list is its own, and both CLIs
 * number tasks from 1, so folding two agents' rows together would have task `1`
 * mean two different things.
 */
export function foldTaskLists(
  rows: readonly { nodeId: string | null; payload: unknown }[],
): RunTaskGroup[] {
  const perAgent = new Map<string | null, RunTaskRow[]>();
  const order: (string | null)[] = [];
  for (const row of rows) {
    const announcement = readTaskAnnouncement(row.payload);
    if (announcement === null) {
      continue;
    }
    if (!perAgent.has(row.nodeId)) {
      perAgent.set(row.nodeId, []);
      order.push(row.nodeId);
    }
    perAgent.set(
      row.nodeId,
      applyAnnouncement(perAgent.get(row.nodeId)!, announcement),
    );
  }
  return order.map((nodeId) => ({ nodeId, tasks: perAgent.get(nodeId)! }));
}

/**
 * Read the run row's stored fold, or `[]` when it holds none.
 *
 * Defensive rather than trusting: the column is TEXT this module wrote, but a
 * row written by an older build (or hand-edited) must degrade to "no list"
 * rather than throwing inside a chat listing.
 */
export function readRunTaskList(stored: string | null): RunTaskGroup[] {
  if (stored === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap((entry): RunTaskGroup[] => {
      if (typeof entry !== 'object' || entry === null) {
        return [];
      }
      const group = entry as { nodeId?: unknown; tasks?: unknown };
      if (!Array.isArray(group.tasks)) {
        return [];
      }
      const announcement = readTaskAnnouncement({
        mode: 'snapshot',
        tasks: group.tasks,
      });
      return announcement === null
        ? []
        : [
            {
              nodeId: typeof group.nodeId === 'string' ? group.nodeId : null,
              tasks: announcement.tasks,
            },
          ];
    });
  } catch {
    return [];
  }
}

/** Serialize a fold for the run row — null when there is nothing to keep. */
export function writeRunTaskList(
  groups: readonly RunTaskGroup[],
): string | null {
  const withRows = groups.filter((group) => group.tasks.length > 0);
  return withRows.length === 0 ? null : JSON.stringify(withRows);
}
