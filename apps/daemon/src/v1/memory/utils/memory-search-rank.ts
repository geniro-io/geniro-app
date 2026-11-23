import {
  MEMORY_COLD_DAYS,
  MEMORY_MARKS_FORGET_THRESHOLD,
  MEMORY_RANK_MARK_STEP,
  MEMORY_RANK_PROJECT_BOOST,
  MEMORY_RANK_TEAM_BOOST,
  MEMORY_RANK_USAGE_HALF_LIFE_DAYS,
  MEMORY_RANK_USAGE_MAX,
  MEMORY_RANK_USAGE_SATURATION_READS,
  type MemoryUsageCount,
} from '../memory.types';
import { DAY_MS, usageDay } from './memory-usage-day';

export interface MemorySearchCandidate {
  id: string;
  handle: number;
  relevance: number;
  projectId: string | null;
  teamSlug: string | null;
}

export interface MemoryRankSignals {
  net: number;
  recentReads: number;
}

export function relevanceOfRanks(
  matches: readonly { rank: number }[],
): number[] {
  if (matches.length === 0) {
    return [];
  }
  const best = Math.min(...matches.map((match) => match.rank));
  if (best >= 0) {
    return matches.map(() => 1);
  }
  return matches.map((match) => Math.max(Number.MIN_VALUE, match.rank / best));
}

export function decayedReads(
  days: readonly MemoryUsageCount[],
  now: Date,
): Map<string, number> {
  const today = dayStart(usageDay(now));
  const weights = new Map<string, number>();
  for (const day of days) {
    const ageDays = Math.max(0, (today - dayStart(day.day)) / DAY_MS);
    if (day.reads === 0 || ageDays > MEMORY_COLD_DAYS) {
      continue;
    }
    const weight =
      day.reads * 0.5 ** (ageDays / MEMORY_RANK_USAGE_HALF_LIFE_DAYS);
    weights.set(day.memoryId, (weights.get(day.memoryId) ?? 0) + weight);
  }
  return weights;
}

export function rankBoost(
  candidate: MemorySearchCandidate,
  signals: MemoryRankSignals | undefined,
): number {
  const net = Math.max(
    -MEMORY_MARKS_FORGET_THRESHOLD,
    Math.min(MEMORY_MARKS_FORGET_THRESHOLD, signals?.net ?? 0),
  );
  const use =
    MEMORY_RANK_USAGE_MAX *
    Math.min(
      1,
      Math.log1p(signals?.recentReads ?? 0) /
        Math.log1p(MEMORY_RANK_USAGE_SATURATION_READS),
    );
  return net * MEMORY_RANK_MARK_STEP + use + scopeBoost(candidate);
}

export function rankSearchCandidates(
  candidates: readonly MemorySearchCandidate[],
  signalsById: ReadonlyMap<string, MemoryRankSignals>,
  limit: number,
): string[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score:
        candidate.relevance *
        (1 + rankBoost(candidate, signalsById.get(candidate.id))),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.relevance - a.candidate.relevance ||
        a.candidate.handle - b.candidate.handle,
    )
    .slice(0, limit)
    .map(({ candidate }) => candidate.id);
}

function scopeBoost(candidate: MemorySearchCandidate): number {
  if (candidate.teamSlug !== null) {
    return MEMORY_RANK_TEAM_BOOST;
  }
  return candidate.projectId === null ? 0 : MEMORY_RANK_PROJECT_BOOST;
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}
