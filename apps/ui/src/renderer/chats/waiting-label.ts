/**
 * The one line a caller's live row says while it is blocked on its own calls.
 *
 * Pure, and in its own module rather than inside `live-row.tsx`, because the
 * thing worth pinning here is the SENTENCE — which agents it names and which it
 * leaves out — and that is answerable without rendering anything.
 */

/** One open call, as the row holds it. */
export interface WaitingCallLabel {
  callId: string;
  /** The callee's display name, or null where this client cannot name it. */
  callee: string | null;
}

/** What an unnamed callee is called — a poorer label than a name, better than silence. */
const UNNAMED_CALLEE = 'a called agent';

/**
 * How many agents the phrase names before it starts counting the rest.
 *
 * Four rather than "all of them": this row shares a line with an elapsed clock
 * and a token bill, and a fan-out of a dozen would push both off the end. The
 * remainder is COUNTED rather than dropped, so the phrase never implies the
 * list is shorter than it is — which is the whole defect this helper exists for.
 */
export const WAITING_LABEL_MAX_NAMES = 4;

/**
 * The call id rides the phrase only when there is exactly ONE call.
 *
 * With one it is the handle for finding that block in a long transcript. With
 * several, `call-23, call-24, call-25` is three times the text for information
 * the blocks themselves carry, and it crowds out the names — which are what the
 * reader asked for.
 */
export function waitingOnLabel(
  calls: readonly WaitingCallLabel[],
): string | null {
  if (calls.length === 0) {
    return null;
  }
  if (calls.length === 1) {
    const [only] = calls;
    return `waiting on ${only!.callee ?? UNNAMED_CALLEE} · ${only!.callId}`;
  }
  // Grouped by NAME, in the order the calls were made: a caller that briefed one
  // agent twice is waiting on one agent, and "Engineer and Engineer" reads as a
  // bug. The count is stated instead, which is the fact the repetition carries.
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = call.callee ?? UNNAMED_CALLEE;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const named = [...counts.entries()].map(([name, count]) =>
    count === 1 ? name : `${name} ×${count}`,
  );
  const shown = named.slice(0, WAITING_LABEL_MAX_NAMES);
  const hidden = named.length - shown.length;
  if (hidden > 0) {
    shown.push(`${hidden} more`);
  }
  return `waiting on ${joinNames(shown)}`;
}

/** `a, b and c` — the last pair joined with "and" rather than a comma. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`;
}
