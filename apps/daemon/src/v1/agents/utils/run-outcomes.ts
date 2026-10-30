import {
  type PullRequestOutcome,
  type RunOutcomeAcceptance,
  RunOutcomeAcceptanceSchema,
} from '../chat.types';
import { pullRequestOutcomeKey } from './pull-request-capture';

/**
 * A github.com pull request URL as an agent writes it into `record_outcome`:
 * the pull request's own page, optionally followed by a sub-page, a query or a
 * fragment (`…/pull/12/files`, `…/pull/12#discussion_r1`). The owner/repo
 * character classes are the capture's (`PULL_REQUEST_URL_LINE`), so the two
 * agree on what a pull request's identity is.
 */
const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)\/pull\/(\d+)(?:[/?#].*)?$/;

export interface PullRequestIdentity {
  owner: string;
  repo: string;
  number: number;
}

/** The pull request a URL names, or null when it is not a github.com pull request page. */
export function parsePullRequestUrl(url: string): PullRequestIdentity | null {
  const match = PULL_REQUEST_URL.exec(url.trim());
  if (match === null) {
    return null;
  }
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) {
    return null;
  }
  return { owner: match[1]!, repo: match[2]!, number };
}

/**
 * `Run.runOutcomes`: the newest outcome per pull request, keyed by
 * `pullRequestOutcomeKey`. Defensive like `readRunPullRequests` — a projection seam
 * reached with hand-built rows — so an unreadable column or entry reads as no
 * outcome rather than throwing inside a listing.
 */
export function readRunOutcomes(
  raw: string | null | undefined,
): Map<string, PullRequestOutcome> {
  const outcomes = new Map<string, PullRequestOutcome>();
  if (raw === null || raw === undefined || raw.length === 0) {
    return outcomes;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return outcomes;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return outcomes;
  }
  for (const [key, entry] of Object.entries(parsed)) {
    const outcome = readOutcome(entry);
    if (outcome !== null) {
      outcomes.set(key, outcome);
    }
  }
  return outcomes;
}

function readOutcome(entry: unknown): PullRequestOutcome | null {
  if (entry === null || typeof entry !== 'object') {
    return null;
  }
  const row = entry as Record<string, unknown>;
  const acceptance = RunOutcomeAcceptanceSchema.safeParse(row.acceptance);
  if (
    !Number.isInteger(row.seq) ||
    typeof row.draft !== 'boolean' ||
    !Number.isInteger(row.reviewRounds) ||
    !Number.isInteger(row.questionsAsked) ||
    !acceptance.success
  ) {
    return null;
  }
  return {
    seq: row.seq as number,
    draft: row.draft,
    reviewRounds: row.reviewRounds as number,
    acceptance: acceptance.data,
    questionsAsked: row.questionsAsked as number,
  };
}

/**
 * The column with `outcome` recorded for `pullRequest`, unless the column
 * already holds a newer one for it (a higher seq): rows are written in seq
 * order per run, but a re-derivation must never move an outcome backwards.
 */
export function withRunOutcome(
  raw: string | null | undefined,
  pullRequest: PullRequestIdentity,
  outcome: PullRequestOutcome,
): string {
  const outcomes = readRunOutcomes(raw);
  const key = pullRequestOutcomeKey(pullRequest);
  const existing = outcomes.get(key);
  if (existing === undefined || existing.seq < outcome.seq) {
    outcomes.set(key, outcome);
  }
  return JSON.stringify(Object.fromEntries(outcomes));
}

/** What one pull request's recorded outcomes say over time, not only at the newest. */
export interface OutcomeHistoryFigures {
  /** How many times it went to `changes_requested`: each arrival from another acceptance, a first outcome that already asks for changes included. */
  changesRequestedRounds: number;
  /** From its first outcome to its first `accepted`; null while it has none. */
  msToAccepted: number | null;
}

export function outcomeHistoryFigures(
  outcomes: readonly {
    seq: number;
    at: Date;
    acceptance: RunOutcomeAcceptance;
  }[],
): OutcomeHistoryFigures {
  const ordered = [...outcomes].sort((a, b) => a.seq - b.seq);
  let changesRequestedRounds = 0;
  let previous: RunOutcomeAcceptance | null = null;
  for (const outcome of ordered) {
    if (
      outcome.acceptance === 'changes_requested' &&
      previous !== 'changes_requested'
    ) {
      changesRequestedRounds += 1;
    }
    previous = outcome.acceptance;
  }
  const first = ordered[0];
  const accepted = ordered.find((outcome) => outcome.acceptance === 'accepted');
  return {
    changesRequestedRounds,
    msToAccepted:
      first === undefined || accepted === undefined
        ? null
        : Math.max(0, accepted.at.getTime() - first.at.getTime()),
  };
}
