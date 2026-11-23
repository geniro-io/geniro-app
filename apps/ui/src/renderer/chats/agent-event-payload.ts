import {
  readWakeNotice,
  readWakeReason,
  type WakeReason,
  type WakeStatus,
} from './wake-payload';

/** One thing that happened to a call an agent made, as its transcript row says it. */
export interface AgentCallEvent {
  kind: 'finished' | 'asked' | 'no-answer';
  callId: string;
  /** The callee, by the name it is recorded under. */
  callee: string;
  calleeMemberId: string | null;
  status: WakeStatus | null;
  result: string | null;
  question: string | null;
  options: string[];
  noAnswer: 'continues' | 'stopped' | null;
}

const TOLD_FINISHED =
  /^Told this agent that (.+) finished (\S+) while it was working\.$/;
const PASSED_QUESTION =
  /^Passed (.+)'s question in (\S+) to this agent while it was working\.$/;
const PICKED_BACK_UP = /^Picked back up — (.+)\.$/;
const STARTED_ANOTHER_TURN =
  /^Started another turn for this agent: (.+) after its turn had ended\.$/;
const ASKED_PART = /^(.+) asked a question in (\S+)$/;
const FINISHED_PART = /^(.+) finished (\S+)$/;
const WENT_ON_WITHOUT_ANSWER =
  /^(.+) asked a question in (\S+) and no turn of this agent was left to answer it, so it goes on without an answer\.$/;
const STOPPED_WITHOUT_ANSWER =
  /^(.+) was stopped: it asked a question in (\S+) and no turn of this agent was left to answer it\.$/;

/**
 * The events an agent's transcript row says happened to its calls, or null
 * when the row says none. Structured keys are read first; a row written before
 * they existed is recognised by its sentence.
 *
 * TWIN PARSER: written by `wakeNotice`, `tellWorkingOwnerFinished`,
 * `tellWorkingOwner` and `orphan` in
 * `apps/daemon/src/v1/teams/services/call-broker.service.ts` (keys `wake`,
 * `toldWorking`, `orphanQuestion`, and the `message` sentences).
 */
export function readAgentCallEvents(payload: unknown): AgentCallEvent[] | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const wake = readWakeNotice(payload);
  if (wake !== null) {
    return wake.map(eventOfReason);
  }
  const toldWorking = readWakeReason(
    (payload as { toldWorking?: unknown }).toldWorking,
  );
  if (toldWorking !== null) {
    return [eventOfReason(toldWorking)];
  }
  const orphan = readOrphanQuestion(
    (payload as { orphanQuestion?: unknown }).orphanQuestion,
  );
  if (orphan !== null) {
    return [orphan];
  }
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' ? readStoredSentence(message) : null;
}

/**
 * The member a call event is about: its own id when that member is in the
 * team, else the one member of the team with the callee's name — names are not
 * unique, so null when none or several have it.
 */
export function memberIdOfEvent(
  event: AgentCallEvent,
  nodes: ReadonlyMap<string, { name: string }> | undefined,
): string | null {
  if (
    event.calleeMemberId !== null &&
    (nodes === undefined || nodes.has(event.calleeMemberId))
  ) {
    return event.calleeMemberId;
  }
  if (nodes === undefined) {
    return null;
  }
  const named = [...nodes].filter(([, node]) => node.name === event.callee);
  const [only] = named;
  return named.length === 1 && only !== undefined ? only[0] : null;
}

function eventOfReason(reason: WakeReason): AgentCallEvent {
  return {
    kind: reason.reason,
    callId: reason.callId,
    callee: reason.callee,
    calleeMemberId: reason.calleeNodeId ?? null,
    status: reason.status ?? null,
    result: reason.result ?? null,
    question: reason.question ?? null,
    options: reason.options ?? [],
    noAnswer: null,
  };
}

function readOrphanQuestion(entry: unknown): AgentCallEvent | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const { callId, callee, calleeNodeId, outcome } = entry as Record<
    string,
    unknown
  >;
  if (
    typeof callId !== 'string' ||
    callId === '' ||
    typeof callee !== 'string' ||
    (outcome !== 'continues' && outcome !== 'stopped')
  ) {
    return null;
  }
  return {
    ...unnamedEvent('no-answer', callee, callId),
    calleeMemberId:
      typeof calleeNodeId === 'string' && calleeNodeId !== ''
        ? calleeNodeId
        : null,
    noAnswer: outcome,
  };
}

function readStoredSentence(message: string): AgentCallEvent[] | null {
  const toldFinished = pairOf(TOLD_FINISHED, message);
  if (toldFinished !== null) {
    return [unnamedEvent('finished', ...toldFinished)];
  }
  const passed = pairOf(PASSED_QUESTION, message);
  if (passed !== null) {
    return [unnamedEvent('asked', ...passed)];
  }
  const reasons =
    singleOf(PICKED_BACK_UP, message) ??
    singleOf(STARTED_ANOTHER_TURN, message);
  if (reasons !== null) {
    return readReasonList(reasons);
  }
  const continues = pairOf(WENT_ON_WITHOUT_ANSWER, message);
  if (continues !== null) {
    return [
      { ...unnamedEvent('no-answer', ...continues), noAnswer: 'continues' },
    ];
  }
  const stopped = pairOf(STOPPED_WITHOUT_ANSWER, message);
  if (stopped !== null) {
    return [{ ...unnamedEvent('no-answer', ...stopped), noAnswer: 'stopped' }];
  }
  return null;
}

function readReasonList(list: string): AgentCallEvent[] | null {
  const events: AgentCallEvent[] = [];
  for (const part of list.split('; ')) {
    const event = readReason(part);
    if (event === null) {
      return null;
    }
    events.push(event);
  }
  return events;
}

function readReason(part: string): AgentCallEvent | null {
  const asked = pairOf(ASKED_PART, part);
  if (asked !== null) {
    return unnamedEvent('asked', ...asked);
  }
  const finished = pairOf(FINISHED_PART, part);
  return finished === null ? null : unnamedEvent('finished', ...finished);
}

function pairOf(pattern: RegExp, text: string): [string, string] | null {
  const [, first, second] = pattern.exec(text) ?? [];
  return first !== undefined && second !== undefined ? [first, second] : null;
}

function singleOf(pattern: RegExp, text: string): string | null {
  const [, only] = pattern.exec(text) ?? [];
  return only ?? null;
}

function unnamedEvent(
  kind: AgentCallEvent['kind'],
  callee: string,
  callId: string,
): AgentCallEvent {
  return {
    kind,
    callId,
    callee,
    calleeMemberId: null,
    status: null,
    result: null,
    question: null,
    options: [],
    noAnswer: null,
  };
}
