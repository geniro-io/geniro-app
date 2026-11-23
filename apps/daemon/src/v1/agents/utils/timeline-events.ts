import type { ItemKind } from '../../runs/runs.types';
import {
  type ChatTimelineEvent,
  type ChatTimelineEventKind,
  type NewestKindPick,
  TIMELINE_EVENTS_MAX,
} from '../chat.types';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  parseJsonColumn,
} from './json-util';

/** A stage move the user would call a step; a nudge or a stall is the daemon talking to itself. */
const SHOWN_STAGE_ACTIONS = ['complete', 'skip', 'reopen', 'handoff'];

/**
 * What the timeline reads newest-first, one index walk each. A kind most of
 * whose rows are no event is narrowed in the read, so those rows never crowd
 * out the ones that are.
 */
export const TIMELINE_EVENT_PICKS: readonly NewestKindPick[] = [
  { kind: 'stage_change', field: 'action', values: SHOWN_STAGE_ACTIONS },
  'run_outcome',
  'thread_outcome',
  'error',
  'call_started',
  'approval_request',
  'report_findings',
  'team_note',
  'show_artifact',
  'milestone',
];

/**
 * The newest failed calls among a run's call records, oldest first: a team
 * run's `call_result` rows are held by `RunKindRowsCache` already, so they are
 * filtered there rather than walked through their payloads in SQL.
 */
export function newestFailedCalls(
  rows: readonly TimelineEventRow[],
  limit: number,
): TimelineEventRow[] {
  const failed: TimelineEventRow[] = [];
  for (let at = rows.length - 1; at >= 0 && failed.length < limit; at -= 1) {
    const row = rows[at]!;
    if (
      row.kind === 'call_result' &&
      asRecord(parseJsonColumn(row.payload))?.status === 'error'
    ) {
      failed.push(row);
    }
  }
  return failed.reverse();
}

/** The kinds that close an approval request, matched by its payload `id`. */
export const APPROVAL_CLOSING_KINDS = [
  'approval_verdict',
  'unanswerable',
] as const satisfies readonly ItemKind[];

const EVENT_TEXT_MAX_CHARS = 200;

export interface TimelineEventRow {
  id: string;
  seq: number;
  kind: string;
  memberId: string | null;
  payload: string;
  createdAt: Date;
}

export interface TimelinePullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  seq: number;
  openedAt: Date;
}

export interface TimelineGoal {
  number: number;
  text: string;
  status: string;
  closedAt: Date | null;
}

export interface TimelineEventSources {
  rows: readonly TimelineEventRow[];
  /** Payload ids of the approval requests a verdict or `unanswerable` row closed. */
  answeredApprovals: ReadonlySet<string>;
  pullRequests: readonly TimelinePullRequest[];
  goals: readonly TimelineGoal[];
  /** The first row the agent wrote after the user first spoke, or null. */
  started: {
    id: string;
    seq: number;
    memberId: string | null;
    createdAt: Date;
  } | null;
}

/** One line of at most {@link EVENT_TEXT_MAX_CHARS} code points, or null when nothing is left. */
export function oneLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const line = text.replace(/\s+/gu, ' ').trim();
  if (line === '') {
    return null;
  }
  const points = [...line];
  return points.length <= EVENT_TEXT_MAX_CHARS
    ? line
    : `${points
        .slice(0, EVENT_TEXT_MAX_CHARS - 1)
        .join('')
        .trimEnd()}…`;
}

function firstLine(text: string | null): string | null {
  return text === null
    ? null
    : oneLine(text.split('\n').find((l) => l.trim() !== '') ?? '');
}

function eventOf(
  kind: ChatTimelineEventKind,
  row: TimelineEventRow,
  fields: Partial<
    Pick<ChatTimelineEvent, 'memberId' | 'text' | 'detail' | 'url' | 'open'>
  >,
): ChatTimelineEvent {
  return {
    id: `${kind}:${row.id}`,
    kind,
    seq: row.seq,
    at: row.createdAt.toISOString(),
    memberId: fields.memberId === undefined ? row.memberId : fields.memberId,
    text: fields.text ?? null,
    detail: fields.detail ?? null,
    url: fields.url ?? null,
    open: fields.open ?? null,
  };
}

/** The event one stored row stands for, or null when it stands for none. */
export function eventOfRow(
  row: TimelineEventRow,
  answeredApprovals: ReadonlySet<string>,
): ChatTimelineEvent | null {
  const payload = asRecord(parseJsonColumn(row.payload));
  if (payload === null) {
    return null;
  }
  switch (row.kind) {
    case 'stage_change': {
      const action = asString(payload.action);
      if (action === null || !SHOWN_STAGE_ACTIONS.includes(action)) {
        return null;
      }
      const by = asRecord(payload.by);
      return eventOf('stage', row, {
        memberId: by?.kind === 'agent' ? asString(by.nodeId) : null,
        text: oneLine(asString(payload.stageTitle)),
        detail: action,
      });
    }
    case 'run_outcome': {
      const number = asNumber(payload.prNumber);
      return eventOf('review', row, {
        memberId: asString(payload.nodeId) ?? row.memberId,
        text: number === null ? null : `#${number}`,
        detail: asString(payload.acceptance),
        url: asString(payload.prUrl),
      });
    }
    case 'thread_outcome':
      return eventOf('finished', row, {
        memberId: asString(payload.nodeId) ?? row.memberId,
        text: firstLine(asString(payload.summary)),
        detail: asString(payload.kind),
      });
    case 'error':
      return eventOf('failure', row, {
        text: firstLine(asString(payload.message)),
      });
    case 'call_result':
      return payload.status === 'error'
        ? eventOf('failure', row, {
            memberId: asString(payload.calleeNodeId) ?? row.memberId,
            text: firstLine(asString(payload.error)),
          })
        : null;
    case 'call_started':
      return eventOf('call', row, {
        memberId: asString(payload.callerNodeId) ?? row.memberId,
        text: oneLine(asString(payload.title)),
        detail: asString(payload.calleeNodeId),
      });
    case 'approval_request': {
      const questions = asArray(payload.questions);
      const id = asString(payload.id);
      const open = id === null ? false : !answeredApprovals.has(id);
      if (questions.length > 0) {
        return eventOf('asked', row, {
          text: oneLine(asString(asRecord(questions[0])?.question)),
          open,
        });
      }
      return eventOf('approval', row, {
        text: oneLine(asString(payload.toolName)),
        open,
      });
    }
    case 'report_findings': {
      const findings = asArray(payload.findings).map(asRecord);
      if (
        findings.length === 0 ||
        findings.every((f) => f?.outcome !== undefined)
      ) {
        return null;
      }
      const first = findings[0];
      return eventOf('problems', row, {
        text: oneLine(
          asString(first?.shortSummary) ?? asString(first?.summary),
        ),
        detail: String(findings.length),
      });
    }
    case 'team_note':
      return eventOf('note', row, {
        memberId: asString(payload.nodeId) ?? row.memberId,
        text: firstLine(asString(payload.text)),
        detail: asString(payload.kind),
      });
    case 'show_artifact':
      return eventOf('page', row, { text: oneLine(asString(payload.title)) });
    case 'milestone':
      return eventOf('step', row, {
        memberId: asString(payload.nodeId) ?? row.memberId,
        text: oneLine(asString(payload.text)),
        detail: asString(payload.kind),
      });
    default:
      return null;
  }
}

function pullRequestEvent(pullRequest: TimelinePullRequest): ChatTimelineEvent {
  return {
    id: `pull_request:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`,
    kind: 'pull_request',
    seq: pullRequest.seq,
    at: pullRequest.openedAt.toISOString(),
    memberId: null,
    text: `#${pullRequest.number}`,
    detail: `${pullRequest.owner}/${pullRequest.repo}`,
    url: pullRequest.url,
    open: null,
  };
}

function goalEvent(goal: TimelineGoal & { closedAt: Date }): ChatTimelineEvent {
  return {
    id: `goal:${goal.number}`,
    kind: 'goal',
    seq: null,
    at: goal.closedAt.toISOString(),
    memberId: null,
    text: oneLine(goal.text),
    detail: null,
    url: null,
    open: null,
  };
}

/**
 * Every event the sources hold, newest first, cut to {@link TIMELINE_EVENTS_MAX}.
 * A cut says so: a shorter list is otherwise indistinguishable from a quieter thread.
 */
export function timelineEvents(sources: TimelineEventSources): {
  events: ChatTimelineEvent[];
  partialReason: string | null;
} {
  const all: ChatTimelineEvent[] = [];
  for (const row of sources.rows) {
    const event = eventOfRow(row, sources.answeredApprovals);
    if (event !== null) {
      all.push(event);
    }
  }
  for (const pullRequest of sources.pullRequests) {
    all.push(pullRequestEvent(pullRequest));
  }
  for (const goal of sources.goals) {
    if (goal.status === 'achieved' && goal.closedAt !== null) {
      all.push(goalEvent({ ...goal, closedAt: goal.closedAt }));
    }
  }
  if (sources.started !== null) {
    all.push({
      id: `started:${sources.started.id}`,
      kind: 'started',
      seq: sources.started.seq,
      at: sources.started.createdAt.toISOString(),
      memberId: sources.started.memberId,
      text: null,
      detail: null,
      url: null,
      open: null,
    });
  }
  all.sort(
    (a, b) =>
      Date.parse(b.at) - Date.parse(a.at) ||
      (b.seq ?? Number.MAX_SAFE_INTEGER) - (a.seq ?? Number.MAX_SAFE_INTEGER),
  );
  if (all.length <= TIMELINE_EVENTS_MAX) {
    return { events: all, partialReason: null };
  }
  return {
    events: all.slice(0, TIMELINE_EVENTS_MAX),
    partialReason: `showing the newest ${TIMELINE_EVENTS_MAX} events — the thread starts earlier than this list does`,
  };
}
