import type { DaemonHandle } from '../shared/contracts';

/** How often an armed project's queue is read. */
const TICK_INTERVAL_MS = 20_000;

/** How long any one daemon call may take before the tick gives up on it. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The approval mode an autopilot run is forced to.
 *
 * `ask` is refused rather than discouraged: no approval request expires
 * (`approval-registry.ts` holds a plain Map with no timer), and a turn's own
 * silence deadline is SUSPENDED while it waits on a verdict — so an unattended
 * `ask` turn does not time out, it waits forever, holding its slot against the
 * cap and its worktree on disk. `acceptEdits` auto-approves edit-kind requests
 * and parks the rest, which is what an unattended run needs.
 */
const AUTOPILOT_APPROVAL = 'acceptEdits';

interface QueuedTask {
  id: string;
  title: string;
  status: string;
  /**
   * Where to cut this card's worktree from, ALREADY RESOLVED by the daemon
   * against the project's folder — see `QueuedTaskSchema`. Read as given: the
   * inheritance rule belongs to the process that holds both rows, and a second
   * reading of it here is how a timer and a board come to work in two
   * different repositories.
   */
  folder: string;
}

interface ProjectQueue {
  projectId: string;
  enabled: boolean;
  breakerOpen: boolean;
  eligible: QueuedTask[];
}

/**
 * Which projects are armed — the ID and nothing else.
 *
 * It carried the project's FOLDER until a card could name one of its own. Now
 * that where to cut a worktree from is a per-task answer, resolved by the
 * daemon and handed out with the queue, a folder here would be a second source
 * for the same question and the only one that cannot see the card.
 */
interface ArmedProject {
  id: string;
}

export interface ConductorDeps {
  /** The daemon to talk to, or null while none is running. */
  handle: () => DaemonHandle | null;
  /** Which projects are armed, read fresh each tick. */
  armedProjects: () => Promise<ArmedProject[]>;
  /** Make the worktree and branch this task will be worked in. */
  prepareWorktree: (input: {
    taskId: string;
    folder: string;
  }) => Promise<{ path: string; branch: string }>;
  /** Give a worktree back when the run could not be started. */
  discardWorktree: (taskId: string) => Promise<unknown>;
  log: (message: string) => void;
  /** Injectable so a spec drives the tick without a real clock. */
  intervalMs?: number;
  fetchTimeoutMs?: number;
}

/**
 * The autopilot: a recurring tick in the Electron MAIN process that drains
 * each armed project's intake column.
 *
 * It lives in main, and not in the renderer or the daemon, for three separate
 * reasons. A renderer timer dies with the window and is throttled in the
 * background long before that. The daemon runs no git, and every task needs a
 * worktree. And main already runs a comparable surviving interval in
 * `UpdateService`, which this is modelled on — created in `start()` after a
 * `stop()`, `unref`'d so it is never the reason the process stays alive, and
 * with its period injected so a spec can drive it without a clock.
 *
 * It DECIDES nothing about capacity. Each tick asks the daemon what may start
 * and starts exactly that; the cap and the breaker are enforced daemon-side,
 * at the route that makes the run. A conductor that counted for itself is the
 * shape two open windows defeat, and this one is written so that being wrong
 * about capacity costs a refused start rather than an extra agent.
 */
export class AutopilotConductor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One tick at a time: a slow tick must not overlap the next. */
  private ticking = false;

  constructor(private readonly deps: ConductorDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? TICK_INTERVAL_MS,
    );
    // Never the reason this process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep. Exposed so a spec drives it directly, like `UpdateService.check`.
   *
   * Every failure is logged and stepped over rather than thrown: this runs on
   * a timer with nobody watching, so a throw would end the sweep at its first
   * bad project and leave every other one unattended until the next tick.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    const handle = this.deps.handle();
    if (handle === null) {
      return;
    }
    this.ticking = true;
    try {
      const projects = await this.deps.armedProjects();
      for (const project of projects) {
        await this.drain(handle, project).catch((error: unknown) => {
          this.deps.log(
            `autopilot could not sweep project ${project.id}: ${reason(error)}`,
          );
        });
      }
    } catch (error) {
      this.deps.log(`autopilot could not read its projects: ${reason(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async drain(
    handle: DaemonHandle,
    project: ArmedProject,
  ): Promise<void> {
    const queue = await this.read<ProjectQueue>(
      handle,
      `/v1/projects/${encodeURIComponent(project.id)}/queue`,
    );
    if (!queue.enabled || queue.breakerOpen) {
      return;
    }
    // The daemon has already narrowed this to the free slots. Starting them
    // one at a time and in order, rather than at once: each start takes a
    // worktree, and a refusal partway through should leave the ones already
    // running alone rather than being answered by a batch that half-failed.
    for (const task of queue.eligible) {
      await this.startOne(handle, task);
    }
  }

  private async startOne(
    handle: DaemonHandle,
    task: QueuedTask,
  ): Promise<void> {
    let worktree: { path: string; branch: string };
    try {
      worktree = await this.deps.prepareWorktree({
        taskId: task.id,
        // The CARD's folder, which the daemon has already resolved against the
        // project's — a card may name a checkout of its own, and the project's
        // is only its default. Reading `project.folder` here would run every
        // autopilot start in the project's repository while a hand-pressed Run
        // on the same card used the one it names.
        folder: task.folder,
      });
    } catch (error) {
      this.deps.log(
        `autopilot could not prepare a worktree for "${task.title}": ${reason(error)}`,
      );
      return;
    }

    try {
      await this.post(handle, `/v1/tasks/${encodeURIComponent(task.id)}/runs`, {
        cwd: worktree.path,
        branch: worktree.branch,
        from: task.status,
        approval: AUTOPILOT_APPROVAL,
        startedBy: 'autopilot',
      });
      this.deps.log(`autopilot started "${task.title}" on ${worktree.branch}`);
    } catch (error) {
      // The daemon refusing is the ordinary case, not an incident: another
      // window's conductor got there first, or the card moved. Give the
      // worktree back so it is not left behind for a run that never began.
      this.deps.log(
        `autopilot did not start "${task.title}": ${reason(error)}`,
      );
      await this.deps
        .discardWorktree(task.id)
        .catch((cleanupError: unknown) => {
          this.deps.log(
            `autopilot could not release the worktree for "${task.title}": ${reason(cleanupError)}`,
          );
        });
    }
  }

  private async read<T>(handle: DaemonHandle, path: string): Promise<T> {
    const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GET ${path} answered ${res.status}`);
    }
    return (await res.json()) as T;
  }

  private async post(
    handle: DaemonHandle,
    path: string,
    body: unknown,
  ): Promise<void> {
    const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`POST ${path} answered ${res.status}`);
    }
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
