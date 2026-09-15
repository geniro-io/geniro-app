/**
 * Fit as many WHOLE items as possible under a character budget, never a
 * truncated fragment of one.
 *
 * Items are visited in order and kept greedily: the first kept item costs its
 * own text length, each later kept item costs `separator.length` plus its own
 * text length, and an item that would push the running length past `budget`
 * is omitted — the walk continues rather than stopping there, so a later
 * short item still gets in after an earlier oversized one was skipped. Order
 * is preserved in both `kept` and `omitted`.
 */
export function capWholeSections<T>(
  items: readonly T[],
  textOf: (item: T) => string,
  separator: string,
  budget: number,
): { kept: T[]; omitted: T[] } {
  const kept: T[] = [];
  const omitted: T[] = [];
  let length = 0;
  for (const item of items) {
    const text = textOf(item);
    const joined =
      kept.length === 0 ? text.length : length + separator.length + text.length;
    if (joined > budget) {
      omitted.push(item);
      continue;
    }
    kept.push(item);
    length = joined;
  }
  return { kept, omitted };
}
