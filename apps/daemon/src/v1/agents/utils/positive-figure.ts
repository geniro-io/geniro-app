/**
 * A figure worth storing: a real number above zero.
 *
 * Zero is rejected as hard as null, and for the reason the renderer's own fold
 * states — a turn that reported `0` measured nothing, and both halves of the
 * ring read it as a denominator or a numerator that cannot be right.
 */
export function positive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
