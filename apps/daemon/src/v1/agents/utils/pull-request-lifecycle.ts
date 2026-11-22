import type {
  PullRequestChangesRequest,
  PullRequestCountsAfter,
  PullRequestDoneMark,
  PullRequestFailedCheck,
  PullRequestLifecycle,
  PullRequestLifecycleRead,
  PullRequestPush,
  PullRequestReviewThread,
} from '../chat.types';
import { asArray, asNumber, asRecord, asString } from './json-util';

/** Each list the query reads is one page of at most this many entries. */
export const LIFECYCLE_PAGE = 100;

/**
 * Check suites and workflow runs land seconds after the push that started
 * them: a head first seen this soon after the pull request opened is the
 * opening push, not one made since.
 */
const OPENING_PUSH_MS = 60_000;

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

const MAX_SKIPPED_WHILE_DRAFT = 30;

const COMMIT_CHECKS = `oid checkSuites(first: 20) { nodes { createdAt conclusion app { slug } workflowRun { workflow { name } } checkRuns(first: 50, filterBy: { conclusions: [FAILURE, TIMED_OUT, STARTUP_FAILURE, SKIPPED] }) { nodes { name conclusion } } } }`;

/**
 * One pull request's life in one GraphQL query: its timeline (ready, draft and
 * force-push events, and the commits with the check suites each started), its
 * review threads and its CHANGES_REQUESTED reviews. A commit's own dates are
 * never read: a rebase rewrites them.
 */
export const PULL_REQUEST_LIFECYCLE_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state isDraft createdAt mergedAt closedAt headRefOid headRefName mergeable timelineItems(first: ${LIFECYCLE_PAGE}, itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_COMMIT]) { filteredCount nodes { __typename ... on ReadyForReviewEvent { createdAt } ... on ConvertToDraftEvent { createdAt } ... on HeadRefForcePushedEvent { createdAt beforeCommit { ${COMMIT_CHECKS} } afterCommit { ${COMMIT_CHECKS} } } ... on PullRequestCommit { commit { ${COMMIT_CHECKS} } } } } reviewThreads(first: ${LIFECYCLE_PAGE}) { totalCount nodes { isResolved isOutdated comments(first: 1) { nodes { createdAt author { __typename login } } } } } reviews(first: ${LIFECYCLE_PAGE}, states: [CHANGES_REQUESTED]) { totalCount nodes { submittedAt author { __typename login } } } } } }`;

/** A workflow run as the Actions REST listing answers it. */
interface ActionsRun {
  createdAt: string;
  headSha: string;
  event: string;
  conclusion: string | null;
  name: string;
  pullRequests: number[];
}

interface CheckSuite {
  createdAt: string;
  conclusion: string | null;
  app: string | null;
  workflow: string | null;
  runs: { name: string; conclusion: string }[];
}

interface Commit {
  sha: string;
  suites: CheckSuite[];
}

interface ForcePush {
  at: string;
  before: Commit | null;
  after: Commit | null;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function timeOrNull(value: unknown): string | null {
  return isTime(value) ? value : null;
}

function ms(value: string): number {
  return Date.parse(value);
}

function author(value: unknown): { login: string | null; bot: boolean } {
  const record = asRecord(value);
  const login = asString(record?.login);
  return {
    login,
    bot: record?.__typename === 'Bot' || (login?.endsWith('[bot]') ?? false),
  };
}

function readCommit(value: unknown): Commit | null {
  const record = asRecord(value);
  const sha = asString(record?.oid);
  if (sha === null) {
    return null;
  }
  const suites: CheckSuite[] = [];
  for (const node of asArray(asRecord(record?.checkSuites)?.nodes)) {
    const suite = asRecord(node);
    if (suite === null || !isTime(suite.createdAt)) {
      continue;
    }
    const workflow = asString(
      asRecord(asRecord(suite.workflowRun)?.workflow)?.name,
    );
    suites.push({
      createdAt: suite.createdAt,
      conclusion: asString(suite.conclusion),
      app: asString(asRecord(suite.app)?.slug),
      workflow,
      runs: asArray(asRecord(suite.checkRuns)?.nodes).flatMap((run) => {
        const name = asString(asRecord(run)?.name);
        const conclusion = asString(asRecord(run)?.conclusion);
        return name === null || conclusion === null
          ? []
          : [{ name, conclusion }];
      }),
    });
  }
  return { sha, suites };
}

/**
 * The Actions REST listing (`/repos/{o}/{r}/actions/runs?branch=…`), one page
 * of it per entry, as the checks this pull request's pushes and events
 * started: a pull-request run naming it, or one of its branch while it was
 * open, since a fork's runs name none. A branch name reused by an earlier pull
 * request is why the window matters; a run started by hand
 * (`workflow_dispatch`) is not a check of the pull request.
 */
export function parseActionsRuns(
  pages: readonly unknown[],
  number: number,
  openFrom: string,
  openUntil: string | null,
): ActionsRun[] {
  const from = ms(openFrom);
  const until = openUntil === null ? Infinity : ms(openUntil);
  const runs: ActionsRun[] = [];
  for (const page of pages) {
    for (const entry of asArray(asRecord(page)?.workflow_runs)) {
      const run = asRecord(entry);
      const createdAt = run?.created_at;
      const headSha = asString(run?.head_sha);
      const event = asString(run?.event);
      if (run === null || !isTime(createdAt) || headSha === null || !event) {
        continue;
      }
      const pullRequests = asArray(run.pull_requests).flatMap((pr) => {
        const value = asNumber(asRecord(pr)?.number);
        return value === null ? [] : [value];
      });
      const at = ms(createdAt);
      const ours =
        event.startsWith('pull_request') &&
        (pullRequests.includes(number) ||
          (pullRequests.length === 0 && at >= from && at <= until));
      if (!ours) {
        continue;
      }
      runs.push({
        createdAt,
        headSha,
        event,
        conclusion: asString(run.conclusion),
        name: workflowName(asString(run.name) ?? asString(run.path) ?? ''),
        pullRequests,
      });
    }
  }
  return runs;
}

/** A run-name such as "PR Checks — #8700 fix(api): …" names its workflow first. */
function workflowName(name: string): string {
  const head = name.split(' — ')[0]!.trim();
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

function draftIntervals(
  createdAt: string,
  readyAt: readonly string[],
  draftedAt: readonly string[],
  isDraft: boolean,
): [number, number][] {
  const events = [
    ...readyAt.map((at) => ({ at: ms(at), ready: true })),
    ...draftedAt.map((at) => ({ at: ms(at), ready: false })),
  ].sort((a, b) => a.at - b.at);
  const intervals: [number, number][] = [];
  const openedAsDraft = events.length > 0 ? events[0]!.ready : isDraft;
  let since: number | null = openedAsDraft ? ms(createdAt) : null;
  for (const event of events) {
    if (event.ready && since !== null) {
      intervals.push([since, event.at]);
      since = null;
    } else if (!event.ready && since === null) {
      since = event.at;
    }
  }
  if (since !== null) {
    intervals.push([since, Infinity]);
  }
  return intervals;
}

function within(at: string, intervals: readonly [number, number][]): boolean {
  const time = ms(at);
  return intervals.some(([from, to]) => time >= from && time < to);
}

/**
 * Every push after the pull request was opened, dated by the earliest check
 * suite or workflow run its head commit started — what a rebase leaves alone —
 * a force push by its own event. A commit nothing dates is part of a push
 * whose head is another commit, and is not one of its own.
 */
function pushesOf(
  createdAt: string,
  commits: readonly Commit[],
  forcePushes: readonly ForcePush[],
  runs: readonly ActionsRun[],
): PullRequestPush[] {
  const firstSeen = new Map<string, number>();
  const see = (sha: string, at: string): void => {
    const time = ms(at);
    const known = firstSeen.get(sha);
    if (known === undefined || time < known) {
      firstSeen.set(sha, time);
    }
  };
  for (const commit of commits) {
    for (const suite of commit.suites) {
      see(commit.sha, suite.createdAt);
    }
  }
  for (const run of runs) {
    see(run.headSha, run.createdAt);
  }
  const forced = new Map<string, number>();
  for (const push of forcePushes) {
    if (push.after !== null) {
      forced.set(push.after.sha, ms(push.at));
    }
  }
  const opened = ms(createdAt);
  const pushes: PullRequestPush[] = [];
  for (const [sha, at] of firstSeen) {
    const forcedAt = forced.get(sha);
    if (forcedAt === undefined && at <= opened + OPENING_PUSH_MS) {
      continue;
    }
    pushes.push({
      sha,
      at: new Date(forcedAt ?? at).toISOString(),
      force: forcedAt !== undefined,
    });
  }
  for (const [sha, at] of forced) {
    if (!firstSeen.has(sha)) {
      pushes.push({ sha, at: new Date(at).toISOString(), force: true });
    }
  }
  return pushes.sort((a, b) => ms(a.at!) - ms(b.at!));
}

function failedChecksOf(
  commits: readonly Commit[],
  runs: readonly ActionsRun[],
  actionsRunsRead: boolean,
): PullRequestFailedCheck[] {
  const failed: PullRequestFailedCheck[] = [];
  const seen = new Set<string>();
  const add = (check: PullRequestFailedCheck): void => {
    const key = `${check.sha} ${check.workflow} ${check.at}`;
    if (!seen.has(key)) {
      seen.add(key);
      failed.push(check);
    }
  };
  if (actionsRunsRead) {
    for (const run of runs) {
      const conclusion = run.conclusion?.toUpperCase() ?? null;
      if (conclusion !== null && FAILED_CONCLUSIONS.has(conclusion)) {
        add({
          sha: run.headSha,
          at: run.createdAt,
          workflow: run.name,
          conclusion: conclusion.toLowerCase(),
        });
      }
    }
  }
  for (const commit of commits) {
    for (const suite of commit.suites) {
      if (actionsRunsRead && suite.app === 'github-actions') {
        continue;
      }
      if (
        suite.conclusion === null ||
        !FAILED_CONCLUSIONS.has(suite.conclusion)
      ) {
        continue;
      }
      add({
        sha: commit.sha,
        at: suite.createdAt,
        workflow: suite.workflow ?? suite.app ?? 'check',
        conclusion: suite.conclusion.toLowerCase(),
      });
    }
  }
  return failed.sort((a, b) => ms(a.at) - ms(b.at));
}

function skippedWhileDraftOf(
  commits: readonly Commit[],
  runs: readonly ActionsRun[],
  intervals: readonly [number, number][],
): string[] {
  const names = new Set<string>();
  for (const run of runs) {
    if (run.conclusion === 'skipped' && within(run.createdAt, intervals)) {
      names.add(run.name);
    }
  }
  for (const commit of commits) {
    for (const suite of commit.suites) {
      if (!within(suite.createdAt, intervals)) {
        continue;
      }
      for (const run of suite.runs) {
        if (run.conclusion === 'SKIPPED') {
          names.add(`${suite.workflow ?? suite.app ?? 'check'}: ${run.name}`);
        }
      }
    }
  }
  return [...names].sort().slice(0, MAX_SKIPPED_WHILE_DRAFT);
}

const STATES: Record<string, PullRequestLifecycle['state']> = {
  OPEN: 'open',
  MERGED: 'merged',
  CLOSED: 'closed',
};

const MERGEABLE = new Set(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);

/** The GraphQL answer's pull request, or null when it carries none. */
export function pullRequestNodeOf(
  answer: unknown,
): Record<string, unknown> | null {
  return asRecord(
    asRecord(asRecord(asRecord(answer)?.data)?.repository)?.pullRequest,
  );
}

/**
 * The pull request's life from the GraphQL answer and its Actions runs, or
 * null when the answer is not a pull request. Defensive throughout: a field
 * GitHub left out costs that field, never the read.
 */
export function parsePullRequestLifecycle(
  answer: unknown,
  actionsPages: readonly unknown[] | null,
  number: number,
): PullRequestLifecycle | null {
  const node = pullRequestNodeOf(answer);
  const state = STATES[asString(node?.state) ?? ''];
  const createdAt = node?.createdAt;
  const headSha = asString(node?.headRefOid);
  if (node === null || state === undefined || !isTime(createdAt) || !headSha) {
    return null;
  }
  const truncated: string[] = [];
  const timeline = asRecord(node.timelineItems);
  const timelineNodes = asArray(timeline?.nodes);
  if ((asNumber(timeline?.filteredCount) ?? 0) > timelineNodes.length) {
    truncated.push('timeline');
  }
  const readyAt: string[] = [];
  const draftedAt: string[] = [];
  const commits: Commit[] = [];
  const forcePushes: ForcePush[] = [];
  for (const entry of timelineNodes) {
    const item = asRecord(entry);
    switch (item?.__typename) {
      case 'ReadyForReviewEvent':
        if (isTime(item.createdAt)) {
          readyAt.push(item.createdAt);
        }
        break;
      case 'ConvertToDraftEvent':
        if (isTime(item.createdAt)) {
          draftedAt.push(item.createdAt);
        }
        break;
      case 'HeadRefForcePushedEvent': {
        if (!isTime(item.createdAt)) {
          break;
        }
        const before = readCommit(item.beforeCommit);
        const after = readCommit(item.afterCommit);
        forcePushes.push({ at: item.createdAt, before, after });
        commits.push(...[before, after].filter((c): c is Commit => c !== null));
        break;
      }
      case 'PullRequestCommit': {
        const commit = readCommit(item.commit);
        if (commit !== null) {
          commits.push(commit);
        }
        break;
      }
    }
  }
  readyAt.sort((a, b) => ms(a) - ms(b));
  draftedAt.sort((a, b) => ms(a) - ms(b));
  const endedAt = timeOrNull(node.mergedAt) ?? timeOrNull(node.closedAt);
  const runs =
    actionsPages === null
      ? []
      : parseActionsRuns(actionsPages, number, createdAt, endedAt);
  if (actionsPages !== null && actionsPages.length > 0) {
    const total = asNumber(asRecord(actionsPages[0])?.total_count) ?? 0;
    const listed = actionsPages.reduce<number>(
      (sum, page) => sum + asArray(asRecord(page)?.workflow_runs).length,
      0,
    );
    if (total > listed) {
      truncated.push('actionsRuns');
    }
  }
  const threadsNode = asRecord(node.reviewThreads);
  const threadNodes = asArray(threadsNode?.nodes);
  if ((asNumber(threadsNode?.totalCount) ?? 0) > threadNodes.length) {
    truncated.push('reviewThreads');
  }
  const reviewThreads: PullRequestReviewThread[] = threadNodes.flatMap(
    (entry) => {
      const thread = asRecord(entry);
      const first = asRecord(asArray(asRecord(thread?.comments)?.nodes)[0]);
      if (thread === null || first === null || !isTime(first.createdAt)) {
        return [];
      }
      const by = author(first.author);
      return [
        {
          openedAt: first.createdAt,
          author: by.login,
          bot: by.bot,
          resolved: thread.isResolved === true,
          outdated: thread.isOutdated === true,
        },
      ];
    },
  );
  const reviewsNode = asRecord(node.reviews);
  const reviewNodes = asArray(reviewsNode?.nodes);
  if ((asNumber(reviewsNode?.totalCount) ?? 0) > reviewNodes.length) {
    truncated.push('reviews');
  }
  const changesRequested: PullRequestChangesRequest[] = reviewNodes.flatMap(
    (entry) => {
      const review = asRecord(entry);
      if (review === null || !isTime(review.submittedAt)) {
        return [];
      }
      const by = author(review.author);
      return [{ at: review.submittedAt, author: by.login, bot: by.bot }];
    },
  );
  const isDraft = node.isDraft === true;
  const intervals = draftIntervals(createdAt, readyAt, draftedAt, isDraft);
  const mergeable = asString(node.mergeable);
  return {
    state,
    isDraft,
    headSha,
    headRef: asString(node.headRefName) ?? '',
    createdAt,
    readyAt: readyAt[0] ?? null,
    readyEvents: readyAt,
    draftedAt,
    mergedAt: timeOrNull(node.mergedAt),
    closedAt: timeOrNull(node.closedAt),
    mergeable:
      mergeable !== null && MERGEABLE.has(mergeable)
        ? (mergeable as PullRequestLifecycle['mergeable'])
        : null,
    pushes: pushesOf(createdAt, commits, forcePushes, runs),
    reviewThreads: reviewThreads.sort(
      (a, b) => ms(a.openedAt) - ms(b.openedAt),
    ),
    changesRequested: changesRequested.sort((a, b) => ms(a.at) - ms(b.at)),
    failedChecks: failedChecksOf(commits, runs, actionsPages !== null),
    skippedWhileDraft: skippedWhileDraftOf(commits, runs, intervals),
    truncated,
    actionsRunsRead: actionsPages !== null,
  };
}

/** What happened to the pull request strictly after `at`. */
export function countsAfter(
  lifecycle: PullRequestLifecycle,
  at: string,
): PullRequestCountsAfter {
  const time = ms(at);
  const after = (value: string | null): boolean =>
    value !== null && ms(value) > time;
  const pushes = lifecycle.pushes.filter((push) => after(push.at));
  const threads = lifecycle.reviewThreads.filter((thread) =>
    after(thread.openedAt),
  );
  return {
    pushes: pushes.length,
    forcePushes: pushes.filter((push) => push.force).length,
    botThreads: threads.filter((thread) => thread.bot).length,
    humanThreads: threads.filter((thread) => !thread.bot).length,
    failedChecks: lifecycle.failedChecks.filter((check) => after(check.at))
      .length,
    changesRequested: lifecycle.changesRequested.filter((review) =>
      after(review.at),
    ).length,
  };
}

/** One GitHub event of a pull request's life, for a timeline beside the run's rows. */
export interface PullRequestEvent {
  at: string;
  kind:
    | 'opened'
    | 'ready'
    | 'draft'
    | 'push'
    | 'force-push'
    | 'review-thread'
    | 'changes-requested'
    | 'check-failed'
    | 'merged'
    | 'closed';
  detail?: string;
}

export function lifecycleEvents(
  lifecycle: PullRequestLifecycle,
): PullRequestEvent[] {
  const events: PullRequestEvent[] = [
    { at: lifecycle.createdAt, kind: 'opened' },
    ...lifecycle.readyEvents.map((at): PullRequestEvent => ({
      at,
      kind: 'ready',
    })),
    ...lifecycle.draftedAt.map((at): PullRequestEvent => ({
      at,
      kind: 'draft',
    })),
    ...lifecycle.pushes.flatMap((push): PullRequestEvent[] =>
      push.at === null
        ? []
        : [
            {
              at: push.at,
              kind: push.force ? 'force-push' : 'push',
              detail: push.sha.slice(0, 7),
            },
          ],
    ),
    ...lifecycle.reviewThreads.map((thread): PullRequestEvent => ({
      at: thread.openedAt,
      kind: 'review-thread',
      detail: `${thread.bot ? 'bot' : 'human'} ${thread.author ?? 'unknown'}${thread.resolved ? ', resolved' : ''}${thread.outdated ? ', outdated' : ''}`,
    })),
    ...lifecycle.changesRequested.map((review): PullRequestEvent => ({
      at: review.at,
      kind: 'changes-requested',
      detail: review.author ?? undefined,
    })),
    ...lifecycle.failedChecks.map((check): PullRequestEvent => ({
      at: check.at,
      kind: 'check-failed',
      detail: `${check.workflow} (${check.conclusion}) on ${check.sha.slice(0, 7)}`,
    })),
  ];
  if (lifecycle.mergedAt !== null) {
    events.push({ at: lifecycle.mergedAt, kind: 'merged' });
  } else if (lifecycle.closedAt !== null) {
    events.push({ at: lifecycle.closedAt, kind: 'closed' });
  }
  return events.sort((a, b) => ms(a.at) - ms(b.at));
}

function msBetween(from: string | null, to: string | null): number | null {
  return from === null || to === null ? null : ms(to) - ms(from);
}

/**
 * A pull request's life as an analysis reads it beside its run: the times,
 * and what happened after the run first said it was done and after it was
 * marked ready. Signed durations: a negative `msDoneToReady` means it was
 * ready before the run said done.
 */
export function lifecycleSummary(
  read: PullRequestLifecycleRead,
  marks: readonly PullRequestDoneMark[],
): Record<string, unknown> {
  if ('unavailable' in read) {
    return { lifecycle: null, lifecycleUnavailable: read.unavailable };
  }
  const lifecycle = read.lifecycle;
  const done = marks[0] ?? null;
  return {
    lifecycle: {
      state: lifecycle.state,
      isDraftNow: lifecycle.isDraft,
      createdAt: lifecycle.createdAt,
      readyAt: lifecycle.readyAt,
      draftedAt: lifecycle.draftedAt,
      mergedAt: lifecycle.mergedAt,
      closedAt: lifecycle.closedAt,
      afterDone:
        done === null
          ? null
          : {
              doneSeq: done.seq,
              doneAt: done.at,
              doneSource: done.source,
              msDoneToReady: msBetween(done.at, lifecycle.readyAt),
              msDoneToMerge: msBetween(done.at, lifecycle.mergedAt),
              ...countsAfter(lifecycle, done.at),
              conflictingNow: lifecycle.mergeable === 'CONFLICTING',
            },
      afterReady:
        lifecycle.readyAt === null
          ? null
          : countsAfter(lifecycle, lifecycle.readyAt),
      totals: {
        pushes: lifecycle.pushes.length,
        reviewThreads: lifecycle.reviewThreads.length,
        failedChecks: lifecycle.failedChecks.length,
        changesRequested: lifecycle.changesRequested.length,
      },
      skippedWhileDraft: lifecycle.skippedWhileDraft,
      ...(lifecycle.truncated.length === 0
        ? {}
        : { truncated: lifecycle.truncated }),
      ...(lifecycle.actionsRunsRead ? {} : { actionsRunsRead: false }),
    },
  };
}
