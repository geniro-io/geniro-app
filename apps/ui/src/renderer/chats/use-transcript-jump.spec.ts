// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { pickJumpAnchor } from './use-transcript-jump';

/**
 * Anchors in DOCUMENT order, each carrying the seq its entry starts at.
 *
 * The two orders are given separately on purpose: the whole point of the
 * function is that they can disagree.
 */
const anchors = (...seqs: (number | string)[]): HTMLElement[] =>
  seqs.map((seq) => {
    const el = document.createElement('div');
    el.dataset.transcriptSeq = String(seq);
    return el;
  });

const seqOf = (el: HTMLElement | null): string | undefined =>
  el?.dataset.transcriptSeq;

describe('pickJumpAnchor', () => {
  it('lands on the entry that ENCLOSES the hit, not on an exact match', () => {
    // Most seqs have no anchor of their own: the fold collapses runs of rows
    // into one turn block, one tool group, one card. A jump to a row inside an
    // entry has to land on that entry.
    expect(seqOf(pickJumpAnchor(anchors(10, 20, 30), 25))).toBe('20');
    expect(seqOf(pickJumpAnchor(anchors(10, 20, 30), 20))).toBe('20');
  });

  it('picks by VALUE even where document order does not rise with seq', () => {
    // The regression this function exists for. A sub-agent block is PLACED
    // where its delegate was launched but STARTS at the first row the delegate
    // wrote, so the entry drawn after it can begin earlier — and a scan that
    // stopped at the first anchor past the hit would answer 10 here, sending
    // the reader to an entry two before the one holding their hit.
    expect(seqOf(pickJumpAnchor(anchors(10, 30, 20), 25))).toBe('20');
  });

  it('lands on the top of what is held when the hit is older than all of it', () => {
    // The honest landing place while the older page is still being fetched,
    // and it beats not moving at all.
    expect(seqOf(pickJumpAnchor(anchors(40, 50), 5))).toBe('40');
  });

  it('ignores an anchor whose seq will not parse, rather than landing on it', () => {
    expect(seqOf(pickJumpAnchor(anchors(10, 'later', 20), 25))).toBe('20');
  });

  it('answers null when there is nowhere to go at all', () => {
    expect(pickJumpAnchor([], 25)).toBeNull();
  });
});
