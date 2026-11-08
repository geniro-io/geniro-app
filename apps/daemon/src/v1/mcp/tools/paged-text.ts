import { PAGE_BYTES } from '../../agents/services/thread-reader.service';

const MIN_PAGE_BODY_BYTES = 1_000;

/** Room a page keeps for its position sentence. */
const POSITION_BYTES = 200;

/**
 * One page of a long answer from `offset`: cut on a line break where one falls
 * in the page's second half, so a page rarely splits a line a `find` would
 * copy, and never inside a surrogate pair. `lead` opens every page and
 * `changedBetweenPages` tells the reader how to notice the text moved. `wrap`
 * frames the page's text, and its bytes count against the page.
 */
export function pagedText(
  lead: string,
  body: string,
  offset: number,
  changedBetweenPages: string,
  wrap: (chunk: string) => string = (chunk) => chunk,
): string {
  if (offset >= body.length && offset > 0) {
    return `${lead} Nothing at offset ${offset}: the answer is ${body.length} characters.`;
  }
  const budget = Math.max(
    MIN_PAGE_BODY_BYTES,
    PAGE_BYTES -
      Buffer.byteLength(lead) -
      Buffer.byteLength(wrap('')) -
      POSITION_BYTES,
  );
  let chunk = body.slice(offset, offset + budget);
  while (chunk.length > 1 && Buffer.byteLength(chunk) > budget) {
    chunk = chunk.slice(0, Math.floor(chunk.length * 0.9));
  }
  if (offset + chunk.length < body.length) {
    const lineEnd = chunk.lastIndexOf('\n');
    if (lineEnd > chunk.length / 2) {
      chunk = chunk.slice(0, lineEnd + 1);
    }
    if (chunk.length > 1 && /[\uD800-\uDBFF]$/.test(chunk)) {
      chunk = chunk.slice(0, -1);
    }
  }
  const end = offset + chunk.length;
  const position =
    offset === 0 && end >= body.length
      ? ''
      : ` Characters ${offset}–${end} of ${body.length}${
          end < body.length
            ? `; the rest: the same call with offset ${end}. ${changedBetweenPages}`
            : ', the last page.'
        }`;
  return `${lead}${position}\n\n${wrap(chunk)}`;
}
