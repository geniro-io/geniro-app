/**
 * The unread mark, read off the run ROW.
 *
 * The daemon keeps two moments per run — `attentionAt`, when it last finished,
 * failed or asked the user something, and `seenAt`, when the user last opened
 * it on ANY device — and broadcasts both, so every window and the phone derive
 * the same mark from the same pair. A run is unread exactly while the first is
 * later than the second.
 */
export interface UnreadMoments {
  attentionAt: string | null;
  seenAt: string | null;
}

/** Whether this run has done something the user has not looked at since. */
export function isUnread(run: UnreadMoments): boolean {
  if (run.attentionAt === null) {
    return false;
  }
  if (run.seenAt === null) {
    return true;
  }
  return Date.parse(run.attentionAt) > Date.parse(run.seenAt);
}

/**
 * The later of two instants. The moments only ever move forward, and two
 * announces about one run can land out of order — so a write keeps whichever is
 * later rather than whichever arrived last.
 */
export function laterInstant(held: string | null, incoming: string): string {
  return held !== null && Date.parse(held) >= Date.parse(incoming)
    ? held
    : incoming;
}
