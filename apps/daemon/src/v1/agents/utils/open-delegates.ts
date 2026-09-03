import { asRecord, asString } from './json-util';

/**
 * The delegates a run's transcript still declares OUT, folded from its own
 * `subagent_info` rows in seq order.
 *
 * It exists because one shipped CLI announces a background delegate's LAUNCH
 * and never its ENDING. Re-measured on cursor-agent 2026.08.31-4057e58: the
 * bundle carries the same seven `cursor/*` extension methods it did in August,
 * none of which reports a delegate finishing, and a real fan-out of nine
 * reviewers produced nine `backgroundOpen: true` rows and not one close across
 * the twelve minutes its process went on living. So the transcript alone can
 * never say a cursor delegate is over, and a reader that waits for it to waits
 * forever.
 *
 * What CAN say so is the process. A cursor delegate runs INSIDE the ACP process
 * that launched it — its own permission requests arrive on the parent's session,
 * and killing that group two seconds after the turn left a delegate unable to
 * finish writing its file — so when the session closes, every delegate still out
 * has demonstrably stopped. `ChatService` folds this set at exactly that moment
 * (and once more at boot, for the closes a SIGKILLed daemon never got to write)
 * and states the ending the CLI would not.
 *
 * The RANKING mirrors the renderer's own `subagentBlockStatus`, and has to: a
 * stated `backgroundOutcome` outranks `backgroundOpen`, because a backgrounded
 * delegate's launching call is answered within the second and the outcome is
 * the only field that speaks about the WORK. A row saying neither says nothing
 * — the announcement carrying a delegate's label or its duration is not a
 * lifecycle claim, and reading it as one would close a delegate that is out.
 */
export function openDelegateIds(payloads: readonly unknown[]): string[] {
  // Insertion-ordered, so the closes are written in the order the delegates
  // were launched — a re-`set` keeps a key's original position, which is what
  // makes a reopened delegate stay where it started rather than jump to the end.
  const open = new Map<string, boolean>();
  for (const payload of payloads) {
    const record = asRecord(payload);
    if (record === null) {
      continue;
    }
    const id = asString(record.id);
    if (id === null || id === '') {
      continue;
    }
    if (asString(record.backgroundOutcome) !== null) {
      open.set(id, false);
      continue;
    }
    if (typeof record.backgroundOpen === 'boolean') {
      open.set(id, record.backgroundOpen);
    }
  }
  return [...open].filter(([, isOpen]) => isOpen).map(([id]) => id);
}
