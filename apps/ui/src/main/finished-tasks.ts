import type { DaemonHandle } from '../shared/contracts';

/** How long the daemon may take to answer before the question is dropped. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Which of these tasks' work is finished, asked of the daemon — or null when
 * it could not answer, which every caller reads as "collect nothing".
 *
 * The question belongs to the daemon because both halves of it are its rows:
 * whether the card is Done, and whether the run on it is still working. This
 * process knows only which worktrees exist.
 *
 * TWIN PARSER: `FinishedTasksDto` in
 * `apps/daemon/src/v1/tasks/dto/task-run.dto.ts`. This process imports no
 * daemon source and not the generated client (that one is the renderer's), so
 * the reply is read defensively rather than typed — the same stance
 * `autopilot-conductor.ts` takes for the queue. Change one and change the
 * other.
 */
export async function readFinishedTasks(
  handle: DaemonHandle,
  taskIds: readonly string[],
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<ReadonlySet<string> | null> {
  try {
    const res = await fetch(
      `http://${handle.host}:${handle.port}/v1/tasks/finished`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskIds }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) {
      return null;
    }
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const answered = (body as { taskIds?: unknown }).taskIds;
    if (!Array.isArray(answered)) {
      return null;
    }
    // Only ids that were ASKED about. A reply naming anything else is not an
    // answer to this question, and acting on it would collect a worktree
    // nobody asked about.
    const asked = new Set(taskIds);
    return new Set(
      answered.filter(
        (id): id is string => typeof id === 'string' && asked.has(id),
      ),
    );
  } catch {
    return null;
  }
}
