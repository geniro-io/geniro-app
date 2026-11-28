import { createHash } from 'node:crypto';

import type { RunWire } from '../../agents/chat.types';

const FINISH_KEY_HASH_CHARS = 16;

/**
 * What a thread's finish is, so the same finish read again is not news: its
 * recorded outcome, else the goals that derived one, else its Done card.
 */
export function finishKeyOf(run: RunWire): string {
  const { outcome } = run;
  if (outcome === null || outcome === undefined) {
    return JSON.stringify(['card']);
  }
  if (outcome.source === 'goals') {
    return JSON.stringify([
      'goals',
      run.goals.map((goal) => [goal.id, goal.status]),
    ]);
  }
  return JSON.stringify([
    'outcome',
    outcome.seq ?? null,
    outcome.kind,
    outcome.summary,
  ]);
}

/**
 * A short, stable name for one finish of a thread, the part of a finished
 * thread's dismissal key that tells one finish from the next. A thread with no
 * recorded outcome carries the time it last finished too (`attentionAt`), so
 * one that runs again and finishes again is a new finish, while a later row
 * written to a finished thread is not.
 */
export function finishKeyHash(run: RunWire): string {
  const finish = finishKeyOf(run);
  const basis =
    run.outcome === null || run.outcome === undefined
      ? JSON.stringify([finish, run.attentionAt ?? null])
      : finish;
  return createHash('sha256')
    .update(basis)
    .digest('hex')
    .slice(0, FINISH_KEY_HASH_CHARS);
}
