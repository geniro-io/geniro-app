import type { HostPatch, HostPlanStep, HostQuestion } from '../chat.types';
import { readHostPatch } from './host-patch';
import { readHostPlan } from './host-plan';
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
 * One column, three cards. A question is the original shape and carries no
 * `kind`, so a row written before plans and patches stood here still reads as
 * a question. A plan or a patch names itself.
 */
export interface PendingQuestionSnapshot {
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

/**
 * A deferred patch. The body is what Apply writes after a restart, so it is
 * the patch `readHostPatch` already capped — never a second, looser copy.
 */
export interface PendingPatchSnapshot {
  kind: 'patch';
  requestId: string;
  patch: HostPatch;
}

export type PendingCardSnapshot =
  PendingQuestionSnapshot | PendingPlanSnapshot | PendingPatchSnapshot;

/** Render one snapshot for `Run.pendingQuestion`. */
export function serializePendingQuestion(
  snapshot: PendingCardSnapshot,
): string {
  if ('kind' in snapshot && snapshot.kind === 'plan') {
    return JSON.stringify({
      kind: 'plan',
      requestId: snapshot.requestId,
      title: snapshot.title,
      steps: snapshot.steps,
    });
  }
  if ('kind' in snapshot && snapshot.kind === 'patch') {
    const { patch } = snapshot;
    return JSON.stringify({
      kind: 'patch',
      requestId: snapshot.requestId,
      file_path: patch.filePath,
      ...(patch.oldString === undefined ? {} : { old_string: patch.oldString }),
      new_string: patch.newString,
      ...(patch.summary === undefined ? {} : { summary: patch.summary }),
    });
  }
  return JSON.stringify(snapshot);
}

/**
 * Read `Run.pendingQuestion` back, or null when there is nothing usable there.
 *
 * Defensive on every field, because this is a TEXT column that outlives the
 * process that wrote it: a row written by an older build, or one hand-edited in
 * a database browser, must cost the card rather than the boot. Questions,
 * plans and patches each go back through the reader the live call uses, so a
 * snapshot can never carry a shape that call would have refused.
 *
 * A row with no `kind` is a question. That is the shape every standing
 * question was written in before this column also held plans and patches.
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
    file_path?: unknown;
    old_string?: unknown;
    new_string?: unknown;
    summary?: unknown;
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
  if (record.kind === 'patch') {
    const read = readHostPatch({
      file_path: record.file_path,
      old_string: record.old_string,
      new_string: record.new_string,
      summary: record.summary,
    });
    if (!read.ok) {
      return null;
    }
    return {
      kind: 'patch',
      requestId: record.requestId,
      patch: read.patch,
    };
  }
  // Anything else that names a kind is not a question and not a card we can
  // re-track. A missing kind, or an explicit `question`, is the original row.
  if (record.kind !== undefined && record.kind !== 'question') {
    return null;
  }
  const questions = readHostQuestions({ questions: record.questions });
  if (questions.length === 0) {
    return null;
  }
  return {
    requestId: record.requestId,
    title: typeof record.title === 'string' ? record.title : null,
    questions,
  };
}
