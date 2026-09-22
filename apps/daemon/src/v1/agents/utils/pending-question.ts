import type { HostQuestion } from '../chat.types';
import { readHostQuestions } from './host-question';

/**
 * The durable half of a DEFERRED question card — what `Run.pendingQuestion`
 * holds, and everything re-tracking one at boot needs.
 *
 * Deliberately NOT a copy of the card: the row the user is looking at is the
 * `approval_request` item, and a second copy of its text is a second thing that
 * can disagree with it. What is here is the pointer (`requestId`) plus what the
 * registry entry itself carries, since `PendingApproval.input` is what the
 * verdict path and the badge read.
 */
export interface PendingQuestionSnapshot {
  /** The `approval_request` item this card was written as. */
  requestId: string;
  /** The card's title, or null when it carried none. */
  title: string | null;
  /** The questions as `readHostQuestions` normalized them. */
  questions: HostQuestion[];
}

/** Render one snapshot for `Run.pendingQuestion`. */
export function serializePendingQuestion(
  snapshot: PendingQuestionSnapshot,
): string {
  return JSON.stringify(snapshot);
}

/**
 * Read `Run.pendingQuestion` back, or null when there is nothing usable there.
 *
 * Defensive on every field, because this is a TEXT column that outlives the
 * process that wrote it: a row written by an older build, or one hand-edited in
 * a database browser, must cost the card rather than the boot. The questions go
 * back through {@link readHostQuestions} rather than being trusted as stored —
 * one normalizer, so a snapshot can never carry a shape the live path would
 * have refused.
 */
export function readPendingQuestion(
  value: string | null,
): PendingQuestionSnapshot | null {
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
    requestId?: unknown;
    title?: unknown;
    questions?: unknown;
  };
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) {
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
