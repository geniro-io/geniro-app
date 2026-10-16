import type {
  RecommendationsLook,
  RecommendationsTimingView,
  RecommendationView,
} from '../components/recommendations-card';
import { categoryToken } from '../stats/charts/chart-theme';
import { formatDuration } from '../stats/stats-format';

/** The app's own look, as the transcript hands it to the card. */
export const LOOK: RecommendationsLook = {
  formatMs: formatDuration,
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
  return {
    id,
    target: workflow ? 'workflow' : id.startsWith('U') ? 'user' : 'repo',
    kind: workflow ? 'parallelize' : 'check',
    location: workflow ? 'reviewer' : 'AGENTS.md:42',
    title: workflow
      ? 'Run the two reviewers in parallel'
      : 'Say which test command to run before review',
    change: workflow
      ? 'edges:\n  - from: builder\n    to: reviewer-a\n  - from: builder\n    to: reviewer-b'
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
    confidence: 3,
    risk: 'low',
  }),
  recommendation('R-1'),
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
