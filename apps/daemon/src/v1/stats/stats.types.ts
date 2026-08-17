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
}

/**
 * A turn that has just been written to the ledger, announced on the WS channel
 * so an open Stats page can refresh itself instead of showing whatever was true
 * when it was opened.
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
  /** When the turn happened — ISO-8601, the same instant the row carries. */
  occurredAt: string;
}

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
  })
  .meta({ id: 'UsageBucket' });
export type UsageBucketWire = z.infer<typeof UsageBucketWireSchema>;

/**
 * One slice of the period — an agent, a model, or a project folder.
 *
 * `key` is nullable because every dimension genuinely can be absent: a turn
 * recorded after its run was deleted knows no folder, and a run that names no
 * model ran on the CLI's own default. Null is left for the client to label, so
 * the daemon never invents a display string like "(unknown)" that a translated
 * or restyled UI would then have to parse back out.
 */
export const UsageGroupWireSchema = z
  .object({
    key: z.string().nullable(),
    totals: ChatTotalsWireSchema,
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
  days: z
    .array(UsageBucketWireSchema)
    .describe('every day in the range, including days with no activity'),
  byAgent: z.array(UsageGroupWireSchema),
  byModel: z.array(UsageGroupWireSchema),
  byProject: z.array(UsageGroupWireSchema),
  byWorkflow: z
    .array(UsageGroupWireSchema)
    .describe('per workflow; the null key is single-agent chats'),
});
// No `.meta({ id })`: this is a RESPONSE DTO ROOT, and nestjs-zod would then
// register the component under the id while the route still points at the DTO
// class name — the dangling `$ref` `setupSwagger` fails the boot on. The nested
// shapes above carry ids precisely because they are not roots.
export type UsageStatsWire = z.infer<typeof UsageStatsWireSchema>;
