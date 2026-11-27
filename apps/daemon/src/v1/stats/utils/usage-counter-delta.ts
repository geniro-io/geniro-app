import type {
  UsageCounterDelta,
  UsageCounterKey,
  UsageCounterRow,
} from '../stats.types';

export function usageCounterKeyOf(key: UsageCounterKey): string {
  return [
    key.subjectKind,
    key.subject,
    key.source,
    key.agentKind,
    key.origin,
    key.projectId,
  ].join('\u0000');
}

/** The counter row of one subject as one agent in one project used it. */
export function usageKey(
  subject: Pick<UsageCounterKey, 'subjectKind' | 'subject' | 'source'>,
  agentKind: string | null,
  origin: UsageCounterKey['origin'],
  projectId: string | null,
): UsageCounterKey {
  return {
    ...subject,
    agentKind: agentKind ?? '',
    origin,
    projectId: projectId ?? '',
  };
}

/** One use at `at`, failed or not. */
export function useDelta(at: number, ok: boolean): Partial<UsageCounterDelta> {
  return { calls: 1, errors: ok ? 0 : 1, firstAt: at, lastAt: at };
}

export function emptyDelta(): UsageCounterDelta {
  return {
    calls: 0,
    errors: 0,
    refused: 0,
    durationMsTotal: 0,
    timedCalls: 0,
    resultCharsTotal: 0,
    sizedCalls: 0,
    offeredSessions: 0,
    firstAt: null,
    lastAt: null,
  };
}

/** Sum rows that share a key, so one statement never names a key twice. */
export function mergeCounterRows(
  rows: readonly UsageCounterRow[],
): UsageCounterRow[] {
  const byKey = new Map<string, UsageCounterRow>();
  for (const row of rows) {
    const key = usageCounterKeyOf(row);
    const held = byKey.get(key);
    byKey.set(key, held === undefined ? { ...row } : addDelta(held, row));
  }
  return [...byKey.values()];
}

export function addDelta<T extends UsageCounterDelta>(
  held: T,
  delta: UsageCounterDelta,
): T {
  return {
    ...held,
    calls: held.calls + delta.calls,
    errors: held.errors + delta.errors,
    refused: held.refused + delta.refused,
    durationMsTotal: held.durationMsTotal + delta.durationMsTotal,
    timedCalls: held.timedCalls + delta.timedCalls,
    resultCharsTotal: held.resultCharsTotal + delta.resultCharsTotal,
    sizedCalls: held.sizedCalls + delta.sizedCalls,
    offeredSessions: held.offeredSessions + delta.offeredSessions,
    firstAt: earlier(held.firstAt, delta.firstAt),
    lastAt: later(held.lastAt, delta.lastAt),
  };
}

function earlier(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

function later(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}
