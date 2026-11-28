import { GENIRO_MCP_SERVER } from '../../agents/utils/tool-metric';
import {
  TOOL_REMOVAL_MIN_AGE_DAYS,
  TOOL_REMOVAL_MIN_OFFERED_SESSIONS,
  type ToolUsageRowWire,
  type ToolUsageSubjectWire,
  type UsageCounterDelta,
  type UsageCounterRow,
  type UsageSubjectKind,
  type UsageSubjectRow,
} from '../stats.types';
import { addDelta, emptyDelta } from './usage-counter-delta';

const DAY_MS = 24 * 60 * 60_000;

interface SubjectId {
  subjectKind: UsageSubjectKind;
  subject: string;
  source: string;
}

interface SubjectTotals extends SubjectId, UsageCounterDelta {
  subagentCalls: number;
  agentCalls: Map<string, number>;
}

export interface ToolUsageFold {
  rows: ToolUsageRowWire[];
  neverCalled: ToolUsageRowWire[];
  /** Epoch ms of the oldest counted use; null before any. */
  oldestUse: number | null;
}

function idOf(subject: SubjectId): string {
  return `${subject.subjectKind}\u0000${subject.subject}\u0000${subject.source}`;
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function isGeniroTool(subject: SubjectId): boolean {
  return subject.subjectKind === 'tool' && subject.source === GENIRO_MCP_SERVER;
}

/**
 * Whether Remove may be proposed for a subject: a Geniro tool this build still
 * has, known at least {@link TOOL_REMOVAL_MIN_AGE_DAYS} days, listed to at
 * least {@link TOOL_REMOVAL_MIN_OFFERED_SESSIONS} sessions, never called. A
 * capability, a CLI's own tool and another MCP server's tool never qualify.
 */
export function removalEligible(
  subject: SubjectId,
  figures: { calls: number; offeredSessions: number },
  known: UsageSubjectRow | undefined,
  current: boolean,
  now: number,
): boolean {
  return (
    isGeniroTool(subject) &&
    current &&
    known !== undefined &&
    known.firstKnownAt <= now - TOOL_REMOVAL_MIN_AGE_DAYS * DAY_MS &&
    figures.offeredSessions >= TOOL_REMOVAL_MIN_OFFERED_SESSIONS &&
    figures.calls === 0
  );
}

/** Every counter row summed per subject, over agent, origin and project. */
export function subjectTotals(
  rows: readonly UsageCounterRow[],
): Map<string, SubjectTotals> {
  const totals = new Map<string, SubjectTotals>();
  for (const row of rows) {
    const id = idOf(row);
    const held = totals.get(id) ?? {
      subjectKind: row.subjectKind,
      subject: row.subject,
      source: row.source,
      subagentCalls: 0,
      agentCalls: new Map<string, number>(),
      ...emptyDelta(),
    };
    const next = addDelta(held, row);
    next.subagentCalls =
      held.subagentCalls + (row.origin === 'subagent' ? row.calls : 0);
    if (row.agentKind !== '' && row.calls > 0) {
      next.agentCalls.set(
        row.agentKind,
        (next.agentCalls.get(row.agentKind) ?? 0) + row.calls,
      );
    }
    totals.set(id, next);
  }
  return totals;
}

function rowOf(
  totals: SubjectTotals,
  known: UsageSubjectRow | undefined,
  current: boolean,
  now: number,
): ToolUsageRowWire {
  return {
    subjectKind: totals.subjectKind,
    subject: totals.subject,
    source: totals.source,
    calls: totals.calls,
    subagentCalls: totals.subagentCalls,
    agents: [...totals.agentCalls.entries()]
      .sort(([a, aCalls], [b, bCalls]) => bCalls - aCalls || a.localeCompare(b))
      .map(([agentKind]) => agentKind),
    errors: totals.errors,
    refused: totals.refused,
    avgDurationMs:
      totals.timedCalls === 0
        ? null
        : Math.round(totals.durationMsTotal / totals.timedCalls),
    avgResultChars:
      totals.sizedCalls === 0
        ? null
        : Math.round(totals.resultCharsTotal / totals.sizedCalls),
    firstAt: iso(totals.firstAt),
    lastAt: iso(totals.lastAt),
    firstKnownAt: iso(known?.firstKnownAt ?? null),
    offeredSessions: isGeniroTool(totals) ? totals.offeredSessions : null,
    removalEligible: removalEligible(totals, totals, known, current, now),
  };
}

/**
 * The brief: every subject with a call, by calls, and every subject this boot
 * registered that was never called. A subject registered by an earlier boot
 * only was retired and is not listed as never called.
 */
export function foldToolUsage(input: {
  rows: readonly UsageCounterRow[];
  subjects: readonly UsageSubjectRow[];
  bootAt: number;
  now: number;
}): ToolUsageFold {
  const totals = subjectTotals(input.rows);
  const known = new Map(
    input.subjects.map((subject) => [idOf(subject), subject]),
  );
  const isCurrent = (id: string): boolean =>
    (known.get(id)?.lastKnownAt ?? -1) >= input.bootAt;
  const rows: ToolUsageRowWire[] = [];
  let oldestUse: number | null = null;
  for (const [id, total] of totals) {
    if (total.calls === 0) {
      continue;
    }
    rows.push(rowOf(total, known.get(id), isCurrent(id), input.now));
    if (total.firstAt !== null) {
      oldestUse =
        oldestUse === null ? total.firstAt : Math.min(oldestUse, total.firstAt);
    }
  }
  const neverCalled = input.subjects
    .filter((subject) => {
      const id = idOf(subject);
      return isCurrent(id) && (totals.get(id)?.calls ?? 0) === 0;
    })
    .map((subject) =>
      rowOf(
        totals.get(idOf(subject)) ?? {
          subjectKind: subject.subjectKind,
          subject: subject.subject,
          source: subject.source,
          subagentCalls: 0,
          agentCalls: new Map<string, number>(),
          ...emptyDelta(),
        },
        subject,
        true,
        input.now,
      ),
    );
  rows.sort((a, b) => b.calls - a.calls || a.subject.localeCompare(b.subject));
  neverCalled.sort(
    (a, b) =>
      a.subjectKind.localeCompare(b.subjectKind) ||
      a.subject.localeCompare(b.subject),
  );
  return { rows, neverCalled, oldestUse };
}

/** One subject's row and its split by agent, origin and project. */
export function foldSubject(input: {
  subject: SubjectId;
  rows: readonly UsageCounterRow[];
  known: UsageSubjectRow | undefined;
  bootAt: number;
  now: number;
  projectNames: ReadonlyMap<string, string>;
}): ToolUsageSubjectWire {
  const total = subjectTotals(input.rows).get(idOf(input.subject)) ?? {
    ...input.subject,
    subagentCalls: 0,
    agentCalls: new Map<string, number>(),
    ...emptyDelta(),
  };
  const slice = <K extends string>(keyOf: (row: UsageCounterRow) => K) => {
    const by = new Map<K, { calls: number; errors: number }>();
    for (const row of input.rows) {
      const key = keyOf(row);
      const held = by.get(key) ?? { calls: 0, errors: 0 };
      by.set(key, {
        calls: held.calls + row.calls,
        errors: held.errors + row.errors,
      });
    }
    return [...by.entries()]
      .filter(([, figures]) => figures.calls > 0 || figures.errors > 0)
      .sort(([, a], [, b]) => b.calls - a.calls);
  };
  return {
    row: rowOf(
      total,
      input.known,
      (input.known?.lastKnownAt ?? -1) >= input.bootAt,
      input.now,
    ),
    byAgent: slice((row) => row.agentKind).map(([agentKind, figures]) => ({
      agentKind: agentKind === '' ? null : agentKind,
      ...figures,
    })),
    byOrigin: slice((row) => row.origin).map(([origin, figures]) => ({
      origin,
      ...figures,
    })),
    byProject: slice((row) => row.projectId).map(([projectId, figures]) => ({
      projectId: projectId === '' ? null : projectId,
      name:
        projectId === '' ? null : (input.projectNames.get(projectId) ?? null),
      ...figures,
    })),
  };
}
