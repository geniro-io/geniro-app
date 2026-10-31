import { formatUsd } from '../chats/agent-activity';
import type {
  RecommendationHotspotView,
  RecommendationsLook,
  RecommendationsTimingView,
  RecommendationView,
  WorkflowStatsView,
} from '../components/recommendations-card';
import { categoryToken } from '../stats/charts/chart-theme';
import { formatDuration, formatPercent } from '../stats/stats-format';

/** The app's own look, as the transcript hands it to the card. */
export const LOOK: RecommendationsLook = {
  formatMs: formatDuration,
  formatUsd,
  formatPercent,
  sinkColor: categoryToken,
};

/** A workflow analysis's card, shared by the card's story and its spec. */
export const TIMING: RecommendationsTimingView = {
  wallMs: 3 * 60 * 60 * 1000,
  activeMs: 2 * 60 * 60 * 1000,
  waitingMs: 25 * 60 * 1000,
  criticalPathMs: 140 * 60 * 1000,
  sinks: [
    { label: 'reviewer', ms: 70 * 60 * 1000 },
    { label: 'builder', ms: 45 * 60 * 1000 },
    { label: 'qa', ms: 15 * 60 * 1000 },
  ],
};

export function recommendation(
  id: string,
  over: Partial<RecommendationView> = {},
): RecommendationView {
  const workflow = id.startsWith('W');
  const memory = id.startsWith('M');
  return {
    id,
    target: workflow
      ? 'workflow'
      : id.startsWith('U')
        ? 'user'
        : memory
          ? 'memory'
          : 'repo',
    territory: memory ? 'domain' : 'process',
    kind: workflow ? 'parallelize' : memory ? 'add' : 'check',
    location: workflow ? 'reviewer' : memory ? 'new' : 'AGENTS.md:42',
    title: workflow
      ? 'Run the two reviewers in parallel'
      : memory
        ? 'Remember that a sent invoice is never edited'
        : 'Say which test command to run before review',
    change: workflow
      ? 'edges:\n  - from: builder\n    to: reviewer-a\n  - from: builder\n    to: reviewer-b'
      : memory
        ? 'A sent invoice is never edited; issue a credit note instead.'
        : 'WHEN a change touches apps/daemon → run `pnpm --filter @geniro/daemon test:unit` before asking for review',
    evidence: [
      {
        seq: 1204,
        ts: '2026-10-14T10:12:00.000Z',
        nodeId: workflow ? 'reviewer' : 'builder',
        quote: 'Waiting for reviewer-a to finish before starting reviewer-b',
      },
    ],
    rootCause: 'Serial calls with no data dependency (MAST 1.3)',
    minutesSaved: workflow ? 22 : 8,
    costSavedUsd: workflow ? 0.4 : null,
    outcome: workflow
      ? 'Both reviews finish in ~12m instead of 34m per run'
      : 'Review rounds 3 → 1',
    basis: 'the reviewer spans on the critical path',
    confidence: 4,
    risk: workflow ? 'medium' : 'low',
    riskNote: 'reviewers stop seeing each other’s notes',
    ...over,
  };
}

export const ITEMS: RecommendationView[] = [
  recommendation('W-1'),
  recommendation('W-2', {
    kind: 'model',
    title: 'Run QA on a smaller model',
    minutesSaved: 6,
    costSavedUsd: 0.85,
    outcome: 'QA turns $0.06 → $0.01 each, the same 8 passes',
    confidence: 3,
    risk: 'low',
  }),
  recommendation('R-1', {
    territory: 'domain',
    kind: 'rule',
    location: '.claude/rules/billing.md',
    title: 'Write down that a sent invoice is never edited',
    change:
      'WHEN a change edits an invoice that was already sent → issue a credit note instead',
    evidence: [
      {
        seq: 1530,
        ts: '2026-10-14T10:48:00.000Z',
        nodeId: 'reviewer',
        quote:
          'Blocking: sent invoices must not be mutated — use a credit note',
      },
    ],
    rootCause: 'The builder did not know sent invoices are immutable',
    riskNote: 'none — it states a rule the code already enforces',
  }),
  recommendation('U-1', {
    kind: 'pointer',
    location: '~/.claude/CLAUDE.md',
    title: 'Point at the repo’s check command instead of guessing one',
    change:
      'WHEN a repository has a `full-check` script → run it before reporting done',
    minutesSaved: 4,
    confidence: 3,
  }),
];

const MINUTE = 60_000;

export const WORKFLOW_STATS: WorkflowStatsView = {
  runs: 8,
  perRun: {
    wallMs: 42 * MINUTE,
    activeMs: 35 * MINUTE,
    waitingOnUserMs: 6 * MINUTE,
    criticalPathMs: 38 * MINUTE,
    turns: 24.5,
    calls: 6.4,
    costUsd: 3.1,
    pricedRuns: 8,
  },
  totals: {
    wallMs: 336 * MINUTE,
    activeMs: 280 * MINUTE,
    turns: 196,
    failedTurns: 7,
    cancelledTurns: 2,
    toolCalls: 1840,
    failedToolCalls: 64,
    calls: 51,
    costUsd: 24.8,
  },
  runList: Array.from({ length: 8 }, (_, at) => ({
    runId: `run-${at}`,
    title: at === 0 ? 'Add credit notes to invoices' : null,
    createdAt: new Date(Date.UTC(2026, 9, 28 - at, 10)).toISOString(),
    version: at < 3 ? 5 : 4,
    current: at < 3,
    wallMs: (30 + ((at * 7) % 25)) * MINUTE,
    activeMs: (25 + ((at * 5) % 20)) * MINUTE,
    waitingOnUserMs: ((at * 3) % 9) * MINUTE,
    turns: 20 + at,
    failedTurns: at % 3 === 0 ? 1 : 0,
    costUsd: 2.4 + at * 0.2,
  })),
  agents: [
    {
      node: 'reviewer',
      agent: 'claude',
      runs: 8,
      turns: 64,
      failedTurns: 3,
      cancelledTurns: 0,
      workedMs: 272 * MINUTE,
      workedPerRunMs: (272 / 8) * MINUTE,
      waitingOnCalleePerRunMs: null,
      criticalPathPerRunMs: (176 / 8) * MINUTE,
      toolCalls: 610,
      failedToolCalls: 22,
      costUsd: 14.4,
      costPerRunUsd: 1.8,
      models: [
        {
          agent: 'claude',
          model: 'opus',
          modelSource: 'reported',
          turns: 64,
          failedTurns: 3,
          cancelledTurns: 0,
          avgTurnMs: 4.2 * MINUTE,
          costUsd: 14.4,
          costPerTurnUsd: 0.225,
        },
      ],
    },
    {
      node: 'builder',
      agent: 'codex',
      runs: 8,
      turns: 72,
      failedTurns: 2,
      cancelledTurns: 2,
      workedMs: 160 * MINUTE,
      workedPerRunMs: (160 / 8) * MINUTE,
      waitingOnCalleePerRunMs: (12 / 8) * MINUTE,
      criticalPathPerRunMs: (96 / 8) * MINUTE,
      toolCalls: 980,
      failedToolCalls: 31,
      costUsd: 7.2,
      costPerRunUsd: 0.9,
      models: [
        {
          agent: 'codex',
          model: 'gpt-5.5-codex',
          modelSource: 'reported',
          turns: 70,
          failedTurns: 2,
          cancelledTurns: 2,
          avgTurnMs: 2.3 * MINUTE,
          costUsd: 7.1,
          costPerTurnUsd: 0.1,
        },
        {
          agent: 'codex',
          model: null,
          modelSource: 'configured',
          turns: 2,
          failedTurns: 0,
          cancelledTurns: 0,
          avgTurnMs: 0.4 * MINUTE,
          costUsd: 0.1,
          costPerTurnUsd: 0.05,
        },
      ],
    },
    {
      node: 'qa',
      agent: 'claude',
      runs: 8,
      turns: 40,
      failedTurns: 2,
      cancelledTurns: 0,
      workedMs: 56 * MINUTE,
      workedPerRunMs: (56 / 8) * MINUTE,
      waitingOnCalleePerRunMs: null,
      criticalPathPerRunMs: (24 / 8) * MINUTE,
      toolCalls: 210,
      failedToolCalls: 9,
      costUsd: 2.5,
      costPerRunUsd: 0.31,
      models: [
        {
          agent: 'claude',
          model: 'opus',
          modelSource: 'reported',
          turns: 40,
          failedTurns: 2,
          cancelledTurns: 0,
          avgTurnMs: 1.4 * MINUTE,
          costUsd: 2.5,
          costPerTurnUsd: 0.0625,
        },
      ],
    },
    {
      node: 'lead',
      agent: 'claude',
      runs: 8,
      turns: 20,
      failedTurns: 0,
      cancelledTurns: 0,
      workedMs: 24 * MINUTE,
      workedPerRunMs: (24 / 8) * MINUTE,
      waitingOnCalleePerRunMs: (230 / 8) * MINUTE,
      criticalPathPerRunMs: (8 / 8) * MINUTE,
      toolCalls: 40,
      failedToolCalls: 2,
      costUsd: 0.7,
      costPerRunUsd: 0.09,
      models: [
        {
          agent: 'claude',
          model: 'sonnet',
          modelSource: 'reported',
          turns: 20,
          failedTurns: 0,
          cancelledTurns: 0,
          avgTurnMs: 1.2 * MINUTE,
          costUsd: 0.7,
          costPerTurnUsd: 0.035,
        },
      ],
    },
  ],
  callEdges: 3,
  calls: [
    {
      caller: 'lead',
      callee: 'reviewer',
      calls: 22,
      failedCalls: 1,
      totalMs: 280 * MINUTE,
      avgMs: 12.7 * MINUTE,
      maxMs: 31 * MINUTE,
      workedMs: 190 * MINUTE,
    },
    {
      caller: 'lead',
      callee: 'builder',
      calls: 21,
      failedCalls: 0,
      totalMs: 170 * MINUTE,
      avgMs: 8.1 * MINUTE,
      maxMs: 19 * MINUTE,
      workedMs: 150 * MINUTE,
    },
    {
      caller: 'lead',
      callee: 'qa',
      calls: 8,
      failedCalls: 1,
      totalMs: 58 * MINUTE,
      avgMs: 7.3 * MINUTE,
      maxMs: 11 * MINUTE,
      workedMs: null,
    },
  ],
};

export const HOTSPOTS: RecommendationHotspotView[] = [
  {
    title: 'The two reviews run one after the other',
    node: 'reviewer',
    why: 'The lead waits for reviewer-a before it calls reviewer-b, though neither reads the other: 22 of the 34 minutes the reviewer holds each run are spent queued behind its own first pass.',
    items: ['W-1', 'R-1'],
  },
  {
    title: 'QA runs on the largest model for a checklist',
    node: 'qa',
    why: 'QA only runs the test command and reads its output, yet every turn runs on opus — a fifth of the price would buy the same 8 passes.',
    items: ['W-2'],
  },
];
