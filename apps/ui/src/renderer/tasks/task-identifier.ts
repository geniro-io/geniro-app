/**
 * A card's identifier, as it is read and written everywhere — `GEN-12`.
 *
 * ONE fold because three surfaces draw it — the board card, the detail panel
 * and each of their accessible names — and `${key}-${number}` written three
 * times is how one of them comes to say `GEN #12`.
 *
 * The daemon owns both halves (`Project.taskKey`, `Task.number`) and states the
 * same rule in `project-key.ts`; this is the renderer twin, which exists
 * because the two values arrive on different rows and only the client holds
 * both at once.
 *
 * Null while either half is missing — a card the backfill has not reached — so
 * a caller draws NOTHING rather than `GEN-0`, which names a card that does not
 * exist, or a bare `-12`, which names no board.
 */
export function taskIdentifier(
  taskKey: string | null | undefined,
  number: number | null | undefined,
): string | null {
  if (
    taskKey === null ||
    taskKey === undefined ||
    taskKey === '' ||
    number === null ||
    number === undefined ||
    number <= 0
  ) {
    return null;
  }
  return `${taskKey}-${number}`;
}
