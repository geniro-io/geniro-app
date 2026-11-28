import { homedir } from 'node:os';

import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  GH_COMMAND_RUNNER,
  type GhCommandRunner,
  type PullRequestLifecycleRead,
  type PullRequestLifecycleUnavailable,
} from '../chat.types';
import type { ManagedCommandResult } from '../utils/managed-command';
import { pullRequestOutcomeKey } from '../utils/pull-request-capture';
import {
  LIFECYCLE_PAGE,
  parsePullRequestLifecycle,
  PULL_REQUEST_LIFECYCLE_QUERY,
  pullRequestNodeOf,
} from '../utils/pull-request-lifecycle';

/** One `gh api` call is a round trip to GitHub; a large timeline answers in seconds. */
export const GH_QUERY_TIMEOUT_MS = 30_000;

/** How long an open pull request's reading is served without asking GitHub again. */
export const OPEN_LIFECYCLE_TTL_MS = 10 * 60_000;

/** How long a "gh is missing or signed out" answer stands, so a read of many does not ask for each. */
const UNAVAILABLE_TTL_MS = 60_000;

/** How long one analysis read may spend asking GitHub; what is left is read on the next one. */
export const LIFECYCLE_READ_BUDGET_MS = 45_000;

export const LIFECYCLE_READ_CONCURRENCY = 8;

/** A call started just before the budget ends still gets this long, rather than none. */
const MIN_GH_TIMEOUT_MS = 5_000;

/** At most this many pages of a branch's Actions runs, LIFECYCLE_PAGE each. */
const ACTIONS_RUN_PAGES = 3;

const MAX_CACHED = 500;

const MAX_GH_OUTPUT_CHARS = 4 * 1024 * 1024;

const ACTIONS_RUN_FIELDS =
  '{total_count, workflow_runs: [.workflow_runs[] | {created_at, head_sha, event, conclusion, name, path, pull_requests: [.pull_requests[] | {number}]}]}';

export interface PullRequestAddress {
  owner: string;
  repo: string;
  number: number;
}

interface Cached {
  read: PullRequestLifecycleRead;
  at: number;
}

function unavailable(
  reason: PullRequestLifecycleUnavailable,
): PullRequestLifecycleRead {
  return { unavailable: reason };
}

function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** Why `gh` gave no pull request, from its own words. */
export function failureOf(
  result: ManagedCommandResult,
): PullRequestLifecycleUnavailable {
  if (result.spawnError !== undefined) {
    return 'gh-missing';
  }
  if (result.timedOut) {
    return 'timed-out';
  }
  const said = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /gh auth login|not logged in|bad credentials|http 401|requires authentication/.test(
      said,
    )
  ) {
    return 'gh-signed-out';
  }
  if (/could not resolve to a|not found|http 404/.test(said)) {
    return 'not-found';
  }
  return 'unreadable';
}

/**
 * A pull request's life on GitHub, read through the user's own `gh` for an
 * analysis of the runs that recorded it
 * (`.claude/rules/network-constraints.md`, item 1): one GraphQL query for its timeline, review threads and
 * changes-requested reviews, and its branch's Actions runs, which keep every
 * push a later rebase rewrote away. Never stored: kept in memory per pull
 * request with the head sha it was read at — a merged or closed one for the
 * daemon's life, an open one for {@link OPEN_LIFECYCLE_TTL_MS}. Never throws:
 * every failure is `unavailable` with its reason.
 */
@Injectable()
export class PullRequestLifecycleService {
  private readonly logger = new Logger(PullRequestLifecycleService.name);
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<
    string,
    Promise<PullRequestLifecycleRead>
  >();

  constructor(
    @Inject(GH_COMMAND_RUNNER) private readonly run: GhCommandRunner,
  ) {}

  private now(): number {
    return Date.now();
  }

  /**
   * Each pull request's reading, at most {@link LIFECYCLE_READ_CONCURRENCY}
   * asked at once, every `gh` call cut to what is left of the budget; one not
   * started within it answers `read-budget-spent` unless a reading is cached.
   */
  async readMany(
    refs: readonly PullRequestAddress[],
    budgetMs = LIFECYCLE_READ_BUDGET_MS,
  ): Promise<Map<string, PullRequestLifecycleRead>> {
    const deadline = this.now() + budgetMs;
    const unique = new Map<string, PullRequestAddress>();
    for (const ref of refs) {
      unique.set(pullRequestOutcomeKey(ref), ref);
    }
    const queue = [...unique.entries()];
    const reads = new Map<string, PullRequestLifecycleRead>();
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [key, ref] = next;
        const cached = this.fresh(key);
        reads.set(
          key,
          cached ??
            (this.now() >= deadline
              ? unavailable('read-budget-spent')
              : await this.read(ref, deadline)),
        );
      }
    };
    await Promise.all(
      Array.from({ length: LIFECYCLE_READ_CONCURRENCY }, worker),
    );
    return reads;
  }

  /** `deadline`, when given, bounds every `gh` call of a read it starts; a read already running is joined as it is. */
  read(
    ref: PullRequestAddress,
    deadline = Infinity,
  ): Promise<PullRequestLifecycleRead> {
    const key = pullRequestOutcomeKey(ref);
    const cached = this.fresh(key);
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    const running = this.inFlight.get(key);
    if (running !== undefined) {
      return running;
    }
    const reading = this.fetch(ref, deadline)
      .catch((error: unknown) => {
        this.logger.warn(
          `pull request ${key} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        return unavailable('unreadable');
      })
      .then((read) => {
        this.remember(key, read);
        return read;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, reading);
    return reading;
  }

  private fresh(key: string): PullRequestLifecycleRead | null {
    const cached = this.cache.get(key);
    if (cached === undefined) {
      return null;
    }
    const age = this.now() - cached.at;
    const read = cached.read;
    const stands =
      'lifecycle' in read
        ? read.lifecycle.state !== 'open' || age < OPEN_LIFECYCLE_TTL_MS
        : read.unavailable === 'not-found'
          ? age < OPEN_LIFECYCLE_TTL_MS
          : age < UNAVAILABLE_TTL_MS;
    return stands ? read : null;
  }

  private remember(key: string, read: PullRequestLifecycleRead): void {
    if (
      'unavailable' in read &&
      (read.unavailable === 'timed-out' ||
        read.unavailable === 'unreadable' ||
        read.unavailable === 'read-budget-spent')
    ) {
      return;
    }
    this.cache.delete(key);
    this.cache.set(key, { read, at: this.now() });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= MAX_CACHED) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private gh(
    args: string[],
    label: string,
    deadline: number,
  ): Promise<ManagedCommandResult> {
    return this.run({
      label,
      args,
      timeoutMs: Math.max(
        MIN_GH_TIMEOUT_MS,
        Math.min(GH_QUERY_TIMEOUT_MS, deadline - this.now()),
      ),
      cwd: homedir(),
      maxOutputChars: MAX_GH_OUTPUT_CHARS,
      endGroupOnExit: true,
    });
  }

  private async fetch(
    ref: PullRequestAddress,
    deadline: number,
  ): Promise<PullRequestLifecycleRead> {
    const result = await this.gh(
      [
        'api',
        'graphql',
        '-f',
        `query=${PULL_REQUEST_LIFECYCLE_QUERY}`,
        '-f',
        `owner=${ref.owner}`,
        '-f',
        `name=${ref.repo}`,
        '-F',
        `number=${ref.number}`,
      ],
      'pr-lifecycle:graphql',
      deadline,
    );
    const answer = jsonOf(result.stdout);
    const node = pullRequestNodeOf(answer);
    if (node === null) {
      return unavailable(failureOf(result));
    }
    const headRef =
      typeof node.headRefName === 'string' ? node.headRefName : '';
    const actionsPages =
      headRef === '' ? null : await this.actionsRuns(ref, headRef, deadline);
    const lifecycle = parsePullRequestLifecycle(
      answer,
      actionsPages,
      ref.number,
    );
    return lifecycle === null ? unavailable('unreadable') : { lifecycle };
  }

  /** The branch's Actions runs page by page, or null when they could not be listed. */
  private async actionsRuns(
    ref: PullRequestAddress,
    branch: string,
    deadline: number,
  ): Promise<unknown[] | null> {
    const pages: unknown[] = [];
    for (let page = 1; page <= ACTIONS_RUN_PAGES; page += 1) {
      if (page > 1 && this.now() >= deadline) {
        break;
      }
      const result = await this.gh(
        [
          'api',
          `repos/${ref.owner}/${ref.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=${LIFECYCLE_PAGE}&page=${page}`,
          '--jq',
          ACTIONS_RUN_FIELDS,
        ],
        'pr-lifecycle:actions',
        deadline,
      );
      const listing = result.code === 0 ? jsonOf(result.stdout) : null;
      const runs =
        typeof listing === 'object' && listing !== null
          ? (listing as { workflow_runs?: unknown }).workflow_runs
          : undefined;
      if (!Array.isArray(runs)) {
        return page === 1 ? null : pages;
      }
      pages.push(listing);
      if (runs.length < LIFECYCLE_PAGE) {
        break;
      }
    }
    return pages;
  }
}
