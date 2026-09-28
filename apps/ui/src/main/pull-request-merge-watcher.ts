import type { DaemonHandle, PullRequestRef } from '../shared/contracts';
import { readPullRequestsByRef } from './github-prs';

/**
 * How often the cards in review are checked against GitHub.
 *
 * FIVE minutes, the same floor `use-thread-pull-requests.ts` refreshes a
 * thread's pull requests on, and for the same reason: a merge happens on
 * somebody else's clock, and asking oftener spends the user's `gh` on an
 * answer that has not changed. A sweep that finds no card in review asks
 * GitHub nothing at all, so an ordinary session costs no lookups whatever —
 * the cost is bounded by the work, not by the timer.
 */
const TICK_INTERVAL_MS = 5 * 60_000;

/** How long any one daemon call may take before the tick gives up on it. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How many pull requests one sweep may ask about.
 *
 * The daemon already caps the CARDS it hands out; this caps the lookups, which
 * is the figure that actually costs a process per repository — one card can
 * name a dozen pull requests if its agent opened that many. Cards are taken in
 * the order the daemon gave them (longest-waiting first), so a capped sweep
 * still reaches every card eventually.
 */
const MAX_WATCHED_PULL_REQUESTS = 60;

/** How much of an unparseable error body one log line may carry. */
const MAX_DETAIL_CHARS = 300;

/** One card in review, as `GET /v1/tasks/awaiting-merge` gives it. */
interface AwaitingMergeTask {
  taskId: string;
  title: string;
  pullRequests: PullRequestRef[];
  /**
   * When the card last entered Done, in epoch milliseconds — null for a card
   * that never has. Only a merge that happened after it can end the card.
   */
  lastDoneAt: number | null;
}

export interface MergeWatcherDeps {
  /** The daemon to talk to, or null while none is running. */
  handle: () => DaemonHandle | null;
  /**
   * Live state for the pull requests a sweep found, through the user's own
   * `gh` login. Injected so a spec drives a tick without a GitHub account.
   */
  readPullRequests?: typeof readPullRequestsByRef;
  log: (message: string) => void;
  /** Injectable so a spec drives the tick without a real clock. */
  intervalMs?: number;
  fetchTimeoutMs?: number;
  now?: () => number;
}

/**
 * The merge watcher: a recurring tick in the Electron MAIN process that ends
 * the cards whose pull requests have landed.
 *
 * A card reaches `in_review` when its agent stops, and nothing could ever take
 * it out of that column but a person dragging it — so a board accumulated
 * finished work whose pull requests had been merged days earlier. This closes
 * the loop: the agent's own `gh pr create` output is already captured on the
 * run, so the card KNOWS which pull requests it is waiting on, and the only
 * missing half is what they currently are.
 *
 * It lives here for `AutopilotConductor`'s three reasons and one of its own,
 * which is the decisive one: **`gh` is in this process**. Every command this
 * app shells out to belongs to main — the daemon runs no git and holds no
 * login — so the daemon can name the pull requests and can never ask about
 * them. A renderer timer would also die with the window and be throttled in
 * the background long before that.
 *
 * It DECIDES nothing about the board. Each tick reports a fact — this pull
 * request merged, and when — and the daemon decides what that means for the
 * card, which is what keeps the rule (a merge ends a card in review, and ends
 * nothing else) in the process that holds the row. Being wrong about a card's
 * column therefore costs a no-op rather than a card dragged out of the column
 * its user just chose for it. The one merge it leaves UNREPORTED is one that
 * happened before its card last reached Done (see `endsCard`): the daemon
 * would refuse it every sweep, and reported first it hid the merge that
 * actually ends the card.
 */
export class PullRequestMergeWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One tick at a time: a slow sweep must not overlap the next. */
  private ticking = false;
  /** When the last sweep finished, for {@link sweepIfStale}. */
  private sweptAt = 0;

  constructor(private readonly deps: MergeWatcherDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.intervalMs());
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
   * Sweep now if the last one is older than the interval.
   *
   * What the window being FOCUSED is worth: a user who merges a pull request
   * in their browser and comes back to geniro is exactly the person waiting to
   * see the card move, and the timer may have just fired. It is the same trade
   * `useThreadPullRequests` makes on its own focus listener, with the same
   * floor, so returning to the window repeatedly cannot turn into a lookup per
   * visit.
   */
  async sweepIfStale(): Promise<void> {
    if (this.now() - this.sweptAt < this.intervalMs()) {
      return;
    }
    await this.tick();
  }

  /**
   * One sweep. Exposed so a spec drives it directly, like `UpdateService.check`.
   *
   * Every failure is logged and stepped over rather than thrown: this runs on
   * a timer with nobody watching, so a throw would end the sweep at its first
   * bad card and leave every other one for the next tick.
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
      const tasks = readAwaitingMerge(
        await this.read(handle, '/v1/tasks/awaiting-merge'),
      );
      await this.settleMerged(handle, tasks);
    } catch (error) {
      this.deps.log(
        `the merge watcher could not read its cards: ${reason(error)}`,
      );
    } finally {
      // Recorded even when the read failed: a daemon that is refusing this
      // route would otherwise have every window focus retry it at once.
      this.sweptAt = this.now();
      this.ticking = false;
    }
  }

  private async settleMerged(
    handle: DaemonHandle,
    tasks: readonly AwaitingMergeTask[],
  ): Promise<void> {
    const wanted = refsOf(tasks, MAX_WATCHED_PULL_REQUESTS);
    if (wanted.length === 0) {
      return;
    }
    const read = this.deps.readPullRequests ?? readPullRequestsByRef;
    // Every merged pull request, with GitHub's merge time — or null when gh
    // gave none, which is a different answer from "not merged".
    const merged = new Map<string, string | null>();
    for (const result of await read(wanted)) {
      if (result.pullRequest?.state === 'merged') {
        merged.set(result.ref.url, result.pullRequest.mergedAt ?? null);
      }
    }
    if (merged.size === 0) {
      return;
    }
    for (const task of tasks) {
      // The FIRST merged one that can still end the card, because one is
      // enough: the card is ended by its work having landed, and a card whose
      // agent opened three pull requests is not waiting for all three.
      //
      // "Can still end it" is the round. A card re-opened after Done continues
      // the same thread, so the pull request that ended it the first time is
      // listed and merged still. Reported, it is refused every sweep; taken
      // first, it hid this round's merge behind it. So a merge counts only if
      // it HAPPENED after the card last reached Done — never judged by when the
      // pull request was opened, since a card dragged to Done and back while
      // its pull request was still open must end when that pull request merges.
      const url = task.pullRequests.find((row) => {
        const mergedAt = merged.get(row.url);
        return mergedAt !== undefined && endsCard(mergedAt, task.lastDoneAt);
      })?.url;
      if (url === undefined) {
        continue;
      }
      await this.reportMerged(handle, task, url, merged.get(url) ?? null);
    }
  }

  private async reportMerged(
    handle: DaemonHandle,
    task: AwaitingMergeTask,
    url: string,
    mergedAt: string | null,
  ): Promise<void> {
    try {
      // TWIN PARSER: `reportPullRequestMergedSchema` in
      // `apps/daemon/src/v1/tasks/dto/task.dto.ts` — `mergedAt` is required
      // there even when null, so an unknown time is said rather than left out.
      await this.post(
        handle,
        `/v1/tasks/${encodeURIComponent(task.taskId)}/pull-request-merged`,
        { url, mergedAt },
      );
      this.deps.log(`"${task.title}" is done — ${url} was merged`);
    } catch (error) {
      // The daemon refusing is an ordinary outcome, not an incident: the card
      // moved while the lookup was in flight, or it was deleted outright.
      this.deps.log(
        `the merge watcher did not end "${task.title}": ${reason(error)}`,
      );
    }
  }

  private intervalMs(): number {
    return this.deps.intervalMs ?? TICK_INTERVAL_MS;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async read(handle: DaemonHandle, path: string): Promise<unknown> {
    const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
      headers: { authorization: `Bearer ${handle.token}` },
      signal: AbortSignal.timeout(this.deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(await describeFailure('GET', path, res));
    }
    return (await res.json()) as unknown;
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
      throw new Error(await describeFailure('POST', path, res));
    }
  }
}

/**
 * The awaiting-merge listing, read as the untrusted JSON it is.
 *
 * TWIN PARSER: `TaskAwaitingMergeSchema` in
 * `apps/daemon/src/v1/tasks/tasks.types.ts`. This process imports no daemon
 * source and not the generated client (that one is the renderer's), so the
 * reply is read defensively rather than typed — the stance `finished-tasks.ts`
 * takes for its own route. Change one and change the other.
 *
 * A reply that is not a list at all throws, which the tick logs. A ROW that
 * cannot be read is dropped and the rest are kept, on `parsePullRequests`'
 * rule. That includes a `lastDoneAt` that is neither null nor a readable time:
 * guessing "never Done" would let a finished round's merge end the card, which
 * is the defect the field exists to prevent, while dropping it costs a drag.
 */
function readAwaitingMerge(body: unknown): AwaitingMergeTask[] {
  if (!Array.isArray(body)) {
    throw new Error('the awaiting-merge listing is not a list');
  }
  return body.flatMap((entry) => {
    const task = readAwaitingRow(entry);
    return task === null ? [] : [task];
  });
}

function readAwaitingRow(entry: unknown): AwaitingMergeTask | null {
  if (typeof entry !== 'object' || entry === null) {
    return null;
  }
  const row = entry as Record<string, unknown>;
  const lastDoneAt = readBoundary(row.lastDoneAt);
  if (
    typeof row.taskId !== 'string' ||
    typeof row.title !== 'string' ||
    !Array.isArray(row.pullRequests) ||
    lastDoneAt === undefined
  ) {
    return null;
  }
  return {
    taskId: row.taskId,
    title: row.title,
    pullRequests: row.pullRequests.flatMap(readRef),
    lastDoneAt,
  };
}

/**
 * `lastDoneAt` as epoch milliseconds: null for a card that has never been
 * Done, undefined when the field says neither.
 */
function readBoundary(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** One pull request the listing names, or nothing when it names none. */
function readRef(entry: unknown): PullRequestRef[] {
  if (typeof entry !== 'object' || entry === null) {
    return [];
  }
  const row = entry as Record<string, unknown>;
  return typeof row.owner === 'string' &&
    typeof row.repo === 'string' &&
    typeof row.number === 'number' &&
    typeof row.url === 'string'
    ? [{ owner: row.owner, repo: row.repo, number: row.number, url: row.url }]
    : [];
}

/**
 * Whether a merge can end a card that last reached Done at `lastDoneAt`: any
 * merge, for a card that never has; otherwise only one known to have happened
 * strictly after it. The daemon's `mergedSince` holds the same line and
 * refuses what this lets through by mistake.
 */
function endsCard(mergedAt: string | null, lastDoneAt: number | null): boolean {
  if (lastDoneAt === null) {
    return true;
  }
  return mergedAt !== null && Date.parse(mergedAt) > lastDoneAt;
}

/**
 * Every pull request one sweep should ask about, deduplicated and capped.
 *
 * Deduplicated by URL because two cards can name the same pull request — one
 * agent's branch reviewed for two tasks — and asking twice about it buys
 * nothing. The cap is applied over the flattened list rather than per card, so
 * one card with fifty captures cannot starve the rest.
 */
function refsOf(
  tasks: readonly AwaitingMergeTask[],
  limit: number,
): PullRequestRef[] {
  const byUrl = new Map<string, PullRequestRef>();
  for (const task of tasks) {
    for (const row of task.pullRequests) {
      if (byUrl.size >= limit) {
        return [...byUrl.values()];
      }
      byUrl.set(row.url, {
        owner: row.owner,
        repo: row.repo,
        number: row.number,
        url: row.url,
      });
    }
  }
  return [...byUrl.values()];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a refused call actually said — the twin of `AutopilotConductor`'s own
 * reader, and kept beside it rather than shared, on that file's own terms: this
 * process holds none of the daemon's types, so the body is untrusted JSON read
 * defensively at each timer that talks to it.
 */
async function describeFailure(
  method: string,
  path: string,
  res: Response,
): Promise<string> {
  const detail = await res
    .text()
    .then((body) => detailOf(body))
    .catch(() => null);
  return detail === null
    ? `${method} ${path} answered ${res.status}`
    : `${method} ${path} answered ${res.status}: ${detail}`;
}

function detailOf(body: string): string | null {
  const text = body.trim();
  if (text === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      const message =
        typeof row.description === 'string'
          ? row.description
          : typeof row.message === 'string'
            ? row.message
            : null;
      if (message !== null) {
        return typeof row.errorCode === 'string'
          ? `${row.errorCode} — ${message}`
          : message;
      }
    }
  } catch {
    // Not JSON: the raw text below is the best that can be said.
  }
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}…`
    : text;
}
