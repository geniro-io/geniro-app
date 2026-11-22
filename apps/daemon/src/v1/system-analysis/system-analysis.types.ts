import { z } from 'zod';

import {
  AgentFlagRunKindSchema,
  AgentFlagWireSchema,
  ItemWireSchema,
  RecommendationIdSchema,
  RunWireSchema,
} from '../agents/chat.types';
import {
  analyzeThreadSchema,
  MAX_ANALYSED_TEAM_RUNS,
} from '../agents/dto/chat.dto';

/** Most threads one system analysis reads; the rest of the period is counted, not read. */
export const SYSTEM_ANALYSIS_MAX_THREADS = MAX_ANALYSED_TEAM_RUNS;
/** Candidates whose transcripts a digest reads for corrections and refused approvals. */
export const SYSTEM_DIGEST_PAYLOAD_CANDIDATES = 200;
/** Flags of deleted threads a digest still lists. */
export const SYSTEM_DIGEST_GONE_FLAGS = 20;
/** Failed tools listed per thread, the most frequent first. */
export const SYSTEM_DIGEST_TOOLS_PER_THREAD = 5;
export const SYSTEM_ANALYSIS_DAYS_MAX = 90;

/** The signal weights of a thread's score; each counted signal times its weight. */
export const SYSTEM_DIGEST_WEIGHTS = {
  workFlag: 5,
  disagreementFlag: 4,
  failedOutcome: 4,
  unmetGoal: 3,
  refusal: 2,
  failedToolCallsCap: 10,
} as const;

export const DigestSignalsSchema = z
  .object({
    workFlags: z.number().int(),
    disagreementFlags: z.number().int(),
    outcome: z.enum(['failed', 'partial']).nullable(),
    unmetGoals: z.number().int(),
    refusedApprovals: z.number().int(),
    corrections: z.number().int(),
    analysisRefusals: z.number().int(),
    failedToolCalls: z.number().int(),
  })
  .meta({ id: 'DigestSignals' });
export type DigestSignals = z.infer<typeof DigestSignalsSchema>;

export const DigestThreadSchema = z
  .object({
    runId: z.string(),
    title: z.string().nullable(),
    kind: AgentFlagRunKindSchema,
    teamSlug: z.string().nullable(),
    projectId: z.string().nullable(),
    archived: z.boolean(),
    lastActivityAt: z.iso.datetime(),
    score: z.number().int(),
    signals: DigestSignalsSchema,
    failedTools: z.array(
      z.object({
        tool: z.string(),
        mcpServer: z.string().nullable(),
        failures: z.number().int(),
      }),
    ),
    /** The run's newest row when the digest was built: every read of it stops there. */
    snapshotSeq: z.number().int(),
  })
  .meta({ id: 'DigestThread' });
export type DigestThread = z.infer<typeof DigestThreadSchema>;

export const SystemPeriodSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    days: z.number().int(),
  })
  .meta({ id: 'SystemPeriod' });
export type SystemPeriod = z.infer<typeof SystemPeriodSchema>;

export const SystemDigestTotalsSchema = z
  .object({
    /** Threads active in the period with any signal, before the cap. */
    threadsWithSignals: z.number().int(),
    flags: z.number().int(),
    failedToolCalls: z.number().int(),
    /** Of the threads with signals, geniro's own: analyses and lessons chats. */
    systemThreads: z.number().int(),
  })
  .meta({ id: 'SystemDigestTotals' });
export type SystemDigestTotals = z.infer<typeof SystemDigestTotalsSchema>;

/** What a system analysis was started on, frozen onto its run (`Run.analysisDigest`). */
export const SystemDigestSchema = z
  .object({
    period: SystemPeriodSchema,
    totals: SystemDigestTotalsSchema,
    /** Every flag of the period on a thread the digest reads, oldest first. */
    flags: z.array(AgentFlagWireSchema),
    /** Flags of threads deleted since, which can be read only here. */
    goneFlags: z.array(AgentFlagWireSchema),
    threads: z.array(DigestThreadSchema),
  })
  .meta({ id: 'SystemDigest' });
export type SystemDigest = z.infer<typeof SystemDigestSchema>;

export const SystemAnalysisScopeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(SYSTEM_ANALYSIS_DAYS_MAX),
});

export const SystemAnalysisScopeSchema = z.object({
  period: SystemPeriodSchema,
  totals: SystemDigestTotalsSchema,
  threads: z.array(DigestThreadSchema),
});
export type SystemAnalysisScope = z.infer<typeof SystemAnalysisScopeSchema>;

/** `POST /v1/system-analyses`: the analysis agent's setup, as "Analyze thread" takes it, and the period. */
export const StartSystemAnalysisSchema = analyzeThreadSchema
  .omit({ cwd: true, images: true })
  .extend({
    days: z.number().int().min(1).max(SYSTEM_ANALYSIS_DAYS_MAX),
  });
export type StartSystemAnalysis = z.infer<typeof StartSystemAnalysisSchema>;

export const SYSTEM_ANALYSIS_STATUSES = [
  'running',
  'waiting',
  'filed',
  'started',
  'kept',
  'failed',
] as const;

export const SystemAnalysisStatusSchema = z
  .enum(SYSTEM_ANALYSIS_STATUSES)
  .meta({ id: 'SystemAnalysisStatus' });
export type SystemAnalysisStatus = z.infer<typeof SystemAnalysisStatusSchema>;

/** One past system analysis, as Settings lists it. */
export const SystemAnalysisRowSchema = z
  .object({
    run: RunWireSchema,
    period: SystemPeriodSchema.nullable(),
    threadsRead: z.number().int(),
    proposals: z.number().int(),
    status: SystemAnalysisStatusSchema,
    filed: z.number().int(),
    started: z.number().int(),
    failed: z.number().int(),
  })
  .meta({ id: 'SystemAnalysisRow' });
export type SystemAnalysisRow = z.infer<typeof SystemAnalysisRowSchema>;

export const SystemAnalysisListSchema = z.object({
  analyses: z.array(SystemAnalysisRowSchema),
  /** The `before` that reads the next page; null when none is left. */
  next: z.iso.datetime().nullable(),
});
export type SystemAnalysisList = z.infer<typeof SystemAnalysisListSchema>;

export const SystemAnalysisListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(3),
  before: z.iso.datetime().optional(),
});

export const SYSTEM_APPLY_ACTIONS = ['cards', 'implement', 'report'] as const;
export const SystemApplyActionSchema = z
  .enum(SYSTEM_APPLY_ACTIONS)
  .meta({ id: 'SystemApplyAction' });
export type SystemApplyAction = z.infer<typeof SystemApplyActionSchema>;

export const SystemApplySchema = z.object({
  cardSeq: z.number().int().min(0),
  ids: z.array(RecommendationIdSchema).max(50),
  action: SystemApplyActionSchema,
  projectId: z.string().min(1).optional(),
  clientMessageId: z.string().min(1).max(200),
});
export type SystemApply = z.infer<typeof SystemApplySchema>;

export const SystemApplyOutcomeSchema = z
  .object({
    id: RecommendationIdSchema,
    status: z.enum(['applied', 'skipped', 'failed']),
    taskId: z.string().optional(),
    identifier: z.string().optional(),
    reason: z.string().optional(),
  })
  .meta({ id: 'SystemApplyOutcome' });
export type SystemApplyOutcome = z.infer<typeof SystemApplyOutcomeSchema>;

export const SystemApplyResultSchema = z.object({
  /** The Apply row written for the press; null when every picked item failed to file, so the card stays open for another press. */
  apply: ItemWireSchema.nullable(),
  outcomes: z.array(SystemApplyOutcomeSchema),
});
export type SystemApplyResult = z.infer<typeof SystemApplyResultSchema>;

/** `read_analyzed_thread view=history` on a system turn: every earlier system item, newest first. */
export const SystemHistorySchema = z.object({
  /** Earlier system analyses with an item in the ledger. */
  analyses: z.number().int(),
  items: z.array(
    z.object({
      chatRunId: z.string(),
      cardSeq: z.number().int(),
      filedAt: z.iso.datetime(),
      id: z.string(),
      target: z.string(),
      location: z.string(),
      title: z.string(),
      rootCause: z.string(),
      status: z.string(),
      note: z.string().nullable(),
      applyAction: z
        .enum(['filed', 'start_requested', 'started', 'kept'])
        .nullable(),
      /** The board card a geniro item was filed as, and the column it sits in now. */
      card: z
        .object({
          taskId: z.string(),
          column: z.string().nullable(),
          deleted: z.boolean(),
        })
        .nullable(),
    }),
  ),
});
export type SystemHistory = z.infer<typeof SystemHistorySchema>;
