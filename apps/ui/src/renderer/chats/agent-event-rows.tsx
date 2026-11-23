import {
  AgentEventStack,
  type EventOutcome,
  MemberEventCard,
  type MemberEventKind,
  MonitorEventCard,
} from './agent-event-card';
import { type AgentCallEvent, memberIdOfEvent } from './agent-event-payload';
import type { PairedCallAnswer } from './call-answers';
import { drawnMonitorEntries, type MonitorNotice } from './monitor-payload';
import type { TranscriptNodeMeta } from './transcript-payload';

type Nodes = ReadonlyMap<string, TranscriptNodeMeta> | undefined;

/** Why an answer never reached the callee that asked, in words. */
export function unansweredWords(
  outcome: Exclude<PairedCallAnswer['outcome'], 'answered'> | string | null,
): string {
  switch (outcome) {
    case 'timeout':
      return 'Timed out — the caller never answered.';
    case 'undelivered':
      return 'Undelivered — the callee ended before the answer arrived.';
    default:
      return 'Orphaned — the caller ended before answering.';
  }
}

/** What a callee did once no turn of its caller was left to answer, in words. */
export function noAnswerWords(
  noAnswer: NonNullable<AgentCallEvent['noAnswer']>,
): string {
  return noAnswer === 'continues'
    ? 'No turn of its caller was left to answer, so it went on without an answer.'
    : 'No turn of its caller was left to answer, so it was stopped.';
}

function eventKindOf(event: AgentCallEvent): MemberEventKind {
  if (event.kind === 'asked') {
    return 'asked';
  }
  if (event.kind === 'no-answer') {
    return 'no-answer';
  }
  return event.status === 'failed' || event.status === 'cancelled'
    ? event.status
    : 'finished';
}

function eventOutcomeOf(event: AgentCallEvent): EventOutcome | null {
  if (event.kind !== 'no-answer') {
    return null;
  }
  return {
    text: noAnswerWords(event.noAnswer ?? 'stopped'),
    tone: 'destructive',
  };
}

function tailOf(event: AgentCallEvent, agent: string | null): string | null {
  if (agent === null || event.delivery === null) {
    return null;
  }
  if (event.delivery === 'woke') {
    return `woke ${agent}`;
  }
  return event.kind === 'asked'
    ? `passed to ${agent} mid-turn`
    : `told ${agent} mid-turn`;
}

/** A row telling an agent what became of its calls, one card per call. */
export function AgentCallEventRow({
  events,
  nodes,
  agent,
  memoryKey,
}: {
  events: readonly AgentCallEvent[];
  nodes: Nodes;
  /** The agent whose transcript holds the row. */
  agent: string | null;
  memoryKey: string;
}): React.JSX.Element {
  return (
    <AgentEventStack>
      {events.map((event, index) => {
        const memberId = memberIdOfEvent(event, nodes);
        const meta = memberId === null ? undefined : nodes?.get(memberId);
        return (
          <MemberEventCard
            key={`${event.callId}:${index}`}
            kind={eventKindOf(event)}
            name={meta?.name ?? event.callee}
            memberId={memberId}
            meta={meta}
            callId={event.callId}
            tail={tailOf(event, agent)}
            text={event.kind === 'asked' ? event.question : event.result}
            options={event.kind === 'asked' ? event.options : []}
            outcome={eventOutcomeOf(event)}
            memoryKey={`${memoryKey}:${index}`}
          />
        );
      })}
    </AgentEventStack>
  );
}

/**
 * What a monitor notice row draws: nothing for a monitor that only started
 * (the tool call row already shows its command), a card per batch or end.
 */
export function MonitorEventRow({
  notice,
  agent,
  memoryKey,
}: {
  notice: MonitorNotice;
  agent: string | null;
  memoryKey: string;
}): React.JSX.Element | null {
  const shown = drawnMonitorEntries(notice);
  if (shown.length === 0) {
    return null;
  }
  return (
    <AgentEventStack>
      {shown.map((entry, index) => (
        <MonitorEventCard
          key={`${entry.id}:${index}`}
          entry={entry}
          woke={notice.woke}
          agent={agent}
          memoryKey={`${memoryKey}:${index}`}
        />
      ))}
    </AgentEventStack>
  );
}
