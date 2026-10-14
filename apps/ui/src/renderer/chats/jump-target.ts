/**
 * How a row says where a jump can land — the DOM half of
 * `use-transcript-jump.ts`, shared by every component that draws one.
 *
 * An ANCHOR is a row a jump can land on: it carries its seq under one of three
 * names (`data-transcript-seq` for a transcript entry, `data-row-seq` for a row
 * inside a turn, a tool group or a sub-agent block, `data-call-seq` for a row
 * of a call card), the seq of a second row it also draws (`data-seq-also` — a
 * tool row's result), and a `data-jump-key` that is unique on the page, which
 * is what the landing mark is matched on: a turn and its first row, or a card
 * and its first row, share a seq.
 *
 * The folds a row is drawn inside are opened from the transcript's structure
 * (`jump-folds.ts`), never from the DOM.
 */

/** The props that make an element a place a jump can land. */
export function jumpAnchorProps(
  kind: 'transcript' | 'row' | 'call',
  seq: number | null,
  key: string,
  /** A second row this one draws — a tool call's result. */
  also: number | null = null,
): Record<string, string | number> {
  if (seq === null) {
    return {};
  }
  const name =
    kind === 'transcript'
      ? 'data-transcript-seq'
      : kind === 'row'
        ? 'data-row-seq'
        : 'data-call-seq';
  return {
    [name]: seq,
    'data-jump-key': key,
    ...(also === null ? {} : { 'data-seq-also': also }),
  };
}
