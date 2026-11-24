export interface WordSpan {
  start: number;
  end: number;
}

export type DiffLineKind = 'removed' | 'added' | 'other';

/**
 * For each removed line paired with the added line in the same place of the
 * run after it, the part of both that differs, widened to whole words. Offsets
 * count the line's sign, its first character.
 */
export function changedSpans(
  lines: readonly string[],
  kinds: readonly DiffLineKind[],
): Map<number, WordSpan> {
  const spans = new Map<number, WordSpan>();
  let index = 0;
  while (index < lines.length) {
    if (kinds[index] !== 'removed') {
      index += 1;
      continue;
    }
    const removed: number[] = [];
    while (kinds[index] === 'removed') {
      removed.push(index);
      index += 1;
    }
    const added: number[] = [];
    while (kinds[index] === 'added') {
      added.push(index);
      index += 1;
    }
    for (
      let pair = 0;
      pair < Math.min(removed.length, added.length);
      pair += 1
    ) {
      const [oldSpan, newSpan] = differingSpans(
        lines[removed[pair]!]!,
        lines[added[pair]!]!,
      );
      spans.set(removed[pair]!, oldSpan);
      spans.set(added[pair]!, newSpan);
    }
  }
  return spans;
}

/** Where two diff lines (sign included) differ, widened to word boundaries. */
export function differingSpans(
  before: string,
  after: string,
): [WordSpan, WordSpan] {
  let start = 1;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  ) {
    start += 1;
  }
  while (start > 1 && !/\s/.test(before[start - 1]!)) {
    start -= 1;
  }
  let shared = 0;
  while (
    shared < before.length - start &&
    shared < after.length - start &&
    before[before.length - 1 - shared] === after[after.length - 1 - shared]
  ) {
    shared += 1;
  }
  while (shared > 0 && !/\s/.test(before[before.length - shared]!)) {
    shared -= 1;
  }
  return [
    { start, end: before.length - shared },
    { start, end: after.length - shared },
  ];
}
