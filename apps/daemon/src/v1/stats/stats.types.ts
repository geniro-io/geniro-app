import { z } from 'zod';

import { ChatTotalsWireSchema } from '../agents/chat.types';
import type { AgentKind } from '../runs/runs.types';

/**
 * One ledger row as its writers hand it over — the shape both the live recorder
 * and the boot backfill produce, so the two cannot disagree about what a usage
 * event is made of.
 */
export interface UsageEventInput {
  runId: string;
  nodeId: string | null;
  seq: number;
  occurredAt: Date;
  agentKind: AgentKind | null;
  model: string | null;
  cwd: string | null;
  workflowName: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
  durationMs: number | null;
  apiMs: number | null;
  ttftMs: number | null;
  timeToRequestMs: number | null;
  numTurns: number | null;
}

/**
 * What one `usage_activity` row records. See its entity for what each kind means and
 * how it is keyed.
 */
export type UsageActivityKind = 'thread' | 'pull_request' | 'lines';

/** A pull request a thread opened, as the transcript's own `gh pr create` result named it. */
export interface PullRequestActivityInput {
  runId: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  occurredAt: Date;
}

/**
 * One cumulative snapshot of a thread's own change totals against its start commit.
 * Only a MEASURED figure is a snapshot: a caller that could not count the changes
 * writes nothing, rather than a zero.
 */
export interface LineSnapshotRow {
  runId: string;
  occurredAt: Date;
  linesAdded: number;
  linesRemoved: number;
  partial: boolean;
}

/** One lines snapshot, as the fold reads it. A null count is a measurement that was never made. */
export interface LineSnapshotRead {
  runId: string;
  occurredAt: Date;
  linesAdded: number | null;
  linesRemoved: number | null;
  partial: boolean | null;
}

/** What one snapshot added past the highest total its thread had reached before it. */
export interface LinesIncrement {
  runId: string;
  occurredAt: Date;
  addedDelta: number;
  removedDelta: number;
  partial: boolean;
}

/** The highest lines total a thread reached before a period: the figure that period's growth is counted past. */
export interface LinesPeak {
  linesAdded: number;
  linesRemoved: number;
}

/**
 * The `seq` of a run's POLLED-spend row — the one ledger row per run that holds
 * what a polled-spend CLI's account poll says the run has cost, rather than a finished turn.
 *
 * A turn row's seq is its transcript row's, which starts at 0, so a negative one
 * can never collide with a real turn, and the `(runId, seq)` unique index then
 * enforces ONE polled row per run with no column of its own. That row is
 * rewritten in place as the poll moves the figure
 * (`UsageEventDao.recordPolledSpend`) — never appended — which is what keeps a
 * running total from being counted once per poll.
 */
export const POLLED_SPEND_SEQ = -1;
// A run's polled bill is several rows — one per day and model — numbered
// downward from this one (`polledSpendRows`), so every seq at or below it is
// polled spend and every one above it is a turn.

/**
 * A ledger row that has just been written — a finished turn, or a run's polled
 * spend moving — announced on the WS channel so an open Stats page can refresh
 * itself instead of showing whatever was true when it was opened.
 *
 * Deliberately NOT the figures themselves. The page's numbers are sums the
 * daemon computes over a range (see `StatsService` on why the client holds no
 * ledger), so a client adding a pushed row to its own totals would be keeping a
 * second, divergent set of books — and the first one it dropped while
 * disconnected would be invisible and permanent. It carries only enough to
 * decide whether the reading on screen is now stale, and the refetch is what
 * answers with figures.
 *
 * Outside the generated HTTP contract (it rides `/ws`, which has no OpenAPI
 * document), so its renderer-side TWIN in `daemon-client.ts` must be changed
 * with it.
 */
export interface UsageRecordedEvent {
  runId: string;
  nodeId: string | null;
  /**
   * When the spend happened — ISO-8601, the same instant the row carries: the
   * turn's own, or for polled spend the run's last activity.
   */
  occurredAt: string;
  /**
   * True for a turn the ledger now holds: the one event a thread's changes are measured after.
   * False for a poll's spend and for a lines snapshot, which move a figure without a turn
   * finishing. Measuring after a snapshot's own announcement would re-read the folder for the
   * total it just wrote, and a folder that keeps changing would then keep writing a row per
   * debounce window.
   */
  turn: boolean;
}

/**
 * What the threads did over a period, beside what they cost. None of it is money, so it
 * is not a second spend ledger.
 *
 * Nullable only where "not measured" and zero are different claims. The line counts are
 * null until some thread was measured in the period, and the average is null when no
 * thread reported a working time. `threadsWithWorkedTime` is the average's denominator,
 * so a reader can see how many threads it stands for.
 */
export const ActivityTotalsWireSchema = z
  .object({
    threadsCreated: z
      .number()
      .int()
      .nonnegative()
      .describe('threads (chats and workflow runs) created in the period'),
    pullRequests: z
      .number()
      .int()
      .nonnegative()
      .describe('pull requests a thread opened in the period'),
    linesAdded: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'lines the threads added in the period; null when no thread was measured then',
      ),
    linesRemoved: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'lines the threads removed in the period; null when no thread was measured then',
      ),
    linesPartial: z
      .boolean()
      .describe(
        'true when a line figure is a lower bound: a listing was truncated, or some files were not counted',
      ),
    activeThreads: z
      .number()
      .int()
      .nonnegative()
      .describe('threads that finished a turn in the period'),
    threadsWithWorkedTime: z
      .number()
      .int()
      .nonnegative()
      .describe('threads whose turns reported their working time'),
    avgWorkedMs: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'the average working time per thread that reported one, in milliseconds; null when none did',
      ),
  })
  .meta({ id: 'ActivityTotals' });
export type ActivityTotalsWire = z.infer<typeof ActivityTotalsWireSchema>;

/**
 * One thread's cumulative change totals, as the desktop app measured them after a
 * finished turn. A measurement that could not be made is not sent at all, so no figure
 * here ever stands in for silence.
 */
/**
 * The most lines one measurement may count, per direction. No real diff reaches it, and the
 * sums of counts this size stay exact integers across any period a client can ask for.
 */
export const MAX_LINE_COUNT = 1_000_000_000;

export const LineSnapshotWireSchema = z.object({
  runId: z.string().min(1).describe('the thread the measurement belongs to'),
  linesAdded: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LINE_COUNT)
    .describe(
      'lines the thread has added against its start commit, cumulative',
    ),
  linesRemoved: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LINE_COUNT)
    .describe(
      'lines the thread has removed against its start commit, cumulative',
    ),
  partial: z
    .boolean()
    .describe(
      'true when the count is a lower bound: a listing was truncated, or some files were not counted',
    ),
  occurredAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'when the measurement was taken; the time the daemon received it when omitted',
    ),
});
export type LineSnapshotInput = z.infer<typeof LineSnapshotWireSchema>;

/** The acknowledgement a recorded measurement earns. */
export const LineSnapshotAckSchema = z.object({ recorded: z.literal(true) });

/**
 * One day's spend.
 *
 * The totals REUSE `ChatTotalsWireSchema` rather than restating its eight
 * fields: a day's spend and a thread's spend are the same aggregate over a
 * different population, and a near-identical second shape is how a field added
 * to one silently stops appearing in the other. The generated client therefore
 * types both against one `ChatTotals`.
 *
 * `date` is a calendar day in the MACHINE's own timezone, not UTC. The daemon
 * and the window looking at it are the same computer by construction, so local
 * is what "today" means to the person reading the page — bucketing by UTC would
 * file a late-evening turn under tomorrow for most of the world.
 */
export const UsageBucketWireSchema = z
  .object({
    date: z.string().describe('calendar day, YYYY-MM-DD, in local time'),
    totals: ChatTotalsWireSchema,
    activity: ActivityTotalsWireSchema.describe(
      'what the threads did that day — see ActivityTotals',
    ),
  })
  .meta({ id: 'UsageBucket' });
export type UsageBucketWire = z.infer<typeof UsageBucketWireSchema>;

/**
 * One slice of the period — an agent, a model, a project folder, or a thread.
 *
 * `key` is nullable because every dimension genuinely can be absent: a turn
 * recorded after its run was deleted knows no folder, and a turn whose CLI
 * reported no model names none. Null is left for the client to label, so the
 * daemon never invents a display string like "(unknown)" that a translated or
 * restyled UI would then have to parse back out.
 *
 * A THREAD's key is its run id, which names nothing a reader recognises, so
 * that dimension alone also carries the thread's own `title` and whether the
 * thread has since been `deleted` — both read off the run at answer time, the
 * ledger keeping no title of its own.
 */
export const UsageGroupWireSchema = z
  .object({
    key: z.string().nullable(),
    totals: ChatTotalsWireSchema,
    title: z
      .string()
      .nullable()
      .optional()
      .describe("a thread's title; null when it has none"),
    deleted: z
      .boolean()
      .optional()
      .describe('a thread that no longer exists — its spend outlives it'),
  })
  .meta({ id: 'UsageGroup' });
export type UsageGroupWire = z.infer<typeof UsageGroupWireSchema>;

/**
 * Everything the Stats page shows for one period.
 *
 * Answered by ONE route, like the chat metrics readout and for the same reason:
 * a page that fetched its headline total and its per-day series separately could
 * show a total that disagrees with the sum of the bars under it, which reads as
 * the app losing track of the user's money.
 *
 * `from`/`to` echo the RESOLVED range rather than the request's, since either
 * bound may be omitted — the page has to be able to say which period it is
 * actually showing.
 */
export const UsageStatsWireSchema = z.object({
  from: z.string().describe('ISO-8601, inclusive'),
  to: z.string().describe('ISO-8601, exclusive'),
  totals: ChatTotalsWireSchema,
  activity: ActivityTotalsWireSchema.describe(
    'what the threads did over the period — the same figures the days sum to',
  ),
  days: z
    .array(UsageBucketWireSchema)
    .describe('every day in the range, including days with no activity'),
  byAgent: z.array(UsageGroupWireSchema),
  byModel: z.array(UsageGroupWireSchema),
  byProject: z
    .array(UsageGroupWireSchema)
    .describe(
      'per project folder; a git worktree is filed under its repository',
    ),
  byThread: z
    .array(UsageGroupWireSchema)
    .describe('per thread (run), keyed by run id — chats and workflow runs'),
});
// No `.meta({ id })`: this is a RESPONSE DTO ROOT, and nestjs-zod would then
// register the component under the id while the route still points at the DTO
// class name — the dangling `$ref` `setupSwagger` fails the boot on. The nested
// shapes above carry ids precisely because they are not roots.
export type UsageStatsWire = z.infer<typeof UsageStatsWireSchema>;
