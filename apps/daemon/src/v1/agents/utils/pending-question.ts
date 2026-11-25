import type {
  HostPlanStep,
  HostPluginProposal,
  HostProjectInstructions,
  HostQuestion,
} from '../chat.types';
import { readHostPlan } from './host-plan';
import { readHostPluginProposal } from './host-plugin';
import { readHostProjectInstructions } from './host-project-instructions';
import { readHostQuestions } from './host-question';

/**
 * The durable half of a DEFERRED card — what `Run.pendingQuestion` holds, and
 * everything re-tracking one at boot needs.
 *
 * Deliberately NOT a copy of the card: the row the user is looking at is the
 * `approval_request` item, and a second copy of its text is a second thing that
 * can disagree with it. What is here is the pointer (`requestId`) plus what the
 * registry entry itself carries, since `PendingApproval.input` is what the
 * verdict path and the badge read.
 *
 * One column, four cards, each naming its `kind`.
 */
export interface PendingQuestionSnapshot {
  kind: 'question';
  /** The `approval_request` item this card was written as. */
  requestId: string;
  /** The card's title, or null when it carried none. */
  title: string | null;
  /** The questions as `readHostQuestions` normalized them. */
  questions: HostQuestion[];
}

/** A deferred plan, standing in the same column as a question. */
export interface PendingPlanSnapshot {
  kind: 'plan';
  requestId: string;
  title: string;
  steps: HostPlanStep[];
}

/** A deferred change to a project's instructions; Apply writes `change`. */
export interface PendingProjectInstructionsSnapshot {
  kind: 'project';
  requestId: string;
  change: HostProjectInstructions;
}

/** A deferred `save_plugin` card; Approve writes `proposal`. */
export interface PendingPluginSnapshot {
  kind: 'plugin';
  requestId: string;
  proposal: HostPluginProposal;
}

export type PendingCardSnapshot =
  | PendingQuestionSnapshot
  | PendingPlanSnapshot
  | PendingProjectInstructionsSnapshot
  | PendingPluginSnapshot;

/**
 * What an agent is told when it raises a DIFFERENT card while one is already
 * standing — or is still being put up. One per run: a chat's durable half is a
 * single column, shared by a question, a plan, a project card and a plugin card.
 */
export const QUESTION_ALREADY_STANDING =
  'a card is already on the user’s screen waiting to be answered — wait for that answer before raising another';

/** Render one snapshot for `Run.pendingQuestion`. */
export function serializePendingQuestion(
  snapshot: PendingCardSnapshot,
): string {
  switch (snapshot.kind) {
    case 'question':
      return JSON.stringify({
        kind: 'question',
        requestId: snapshot.requestId,
        title: snapshot.title,
        questions: snapshot.questions,
      });
    case 'plan':
      return JSON.stringify({
        kind: 'plan',
        requestId: snapshot.requestId,
        title: snapshot.title,
        steps: snapshot.steps,
      });
    case 'project':
      return JSON.stringify({
        kind: 'project',
        requestId: snapshot.requestId,
        change: snapshot.change,
      });
    case 'plugin':
      return JSON.stringify({
        kind: 'plugin',
        requestId: snapshot.requestId,
        proposal: snapshot.proposal,
      });
  }
}

/** The card id a stored column points at, read even from a row no reader accepts. */
export function pendingCardRequestId(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    const { requestId } = parsed as { requestId?: unknown };
    return typeof requestId === 'string' && requestId.length > 0
      ? requestId
      : null;
  } catch {
    return null;
  }
}

/**
 * Read `Run.pendingQuestion` back, or null when there is nothing usable there.
 *
 * Defensive on every field, because this is a TEXT column that outlives the
 * process that wrote it: a row written by an older build, or one hand-edited in
 * a database browser, must cost the card rather than the boot. Each card goes
 * back through the reader the live call uses, so a snapshot can never carry a
 * shape that call would have refused.
 *
 * A row must name a `kind` this build still raises. One that names none, or a
 * kind no longer raised, reads as null and is cleared at boot like any other
 * unreadable row: there is no compatibility reader for it.
 */
export function readPendingQuestion(
  value: string | null,
): PendingCardSnapshot | null {
  if (value === null || value.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as {
    kind?: unknown;
    requestId?: unknown;
    title?: unknown;
    questions?: unknown;
    steps?: unknown;
    change?: unknown;
    proposal?: unknown;
  };
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) {
    return null;
  }
  if (record.kind === 'plan') {
    const read = readHostPlan({ title: record.title, steps: record.steps });
    if (!read.ok) {
      return null;
    }
    return {
      kind: 'plan',
      requestId: record.requestId,
      title: read.plan.title,
      steps: read.plan.steps,
    };
  }
  if (record.kind === 'project') {
    const change = readHostProjectInstructions(record.change);
    return change === null
      ? null
      : { kind: 'project', requestId: record.requestId, change };
  }
  if (record.kind === 'plugin') {
    const proposal = readHostPluginProposal(record.proposal);
    return proposal === null
      ? null
      : { kind: 'plugin', requestId: record.requestId, proposal };
  }
  if (record.kind !== 'question') {
    return null;
  }
  const questions = readHostQuestions({ questions: record.questions });
  if (questions.length === 0) {
    return null;
  }
  return {
    kind: 'question',
    requestId: record.requestId,
    title: typeof record.title === 'string' ? record.title : null,
    questions,
  };
}
