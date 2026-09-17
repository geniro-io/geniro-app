/**
 * The card's labels, tolerating a column written by an older build or by a
 * hand that edited the database — a corrupt row renders as NO labels rather
 * than failing the whole board.
 *
 * Shared by `TasksService.toWire` (the board's own projection) and
 * `LabelInstructionsService.forTask` (which labels attach instructions) —
 * extracted rather than mirrored, so the two readers cannot silently disagree
 * about what one row's `labels` column means.
 */
export function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((label): label is string => typeof label === 'string');
  } catch {
    return [];
  }
}
