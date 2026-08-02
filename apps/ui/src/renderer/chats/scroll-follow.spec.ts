import { describe, expect, it } from 'vitest';

import { isScrolledToBottom } from './scroll-follow';

/** A 400px-tall viewport over 1000px of transcript: 600px of scroll range. */
function scroller(scrollTop: number): {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
} {
  return { scrollTop, scrollHeight: 1000, clientHeight: 400 };
}

describe('isScrolledToBottom', () => {
  it('follows the tail when the viewport is pinned to the bottom', () => {
    expect(isScrolledToBottom(scroller(600))).toBe(true);
  });

  it('does NOT follow when the user has scrolled up to read', () => {
    // The defect this gates: a new item arriving here used to yank the
    // viewport back down mid-read.
    expect(isScrolledToBottom(scroller(0))).toBe(false);
    expect(isScrolledToBottom(scroller(300))).toBe(false);
    expect(isScrolledToBottom(scroller(560))).toBe(false);
  });

  it('tolerates a few pixels of rounding slack, but not a real scroll-up', () => {
    // A smooth scroll can land fractionally short; that must still count as
    // "at the bottom" or the tail unsticks itself after one animation.
    expect(isScrolledToBottom(scroller(599.5))).toBe(true);
    expect(isScrolledToBottom(scroller(577))).toBe(true);
    expect(isScrolledToBottom(scroller(575))).toBe(false);
  });

  it('treats a transcript shorter than its viewport as at the bottom', () => {
    // Nothing to scroll — every new row should still be followed.
    expect(
      isScrolledToBottom({
        scrollTop: 0,
        scrollHeight: 200,
        clientHeight: 400,
      }),
    ).toBe(true);
  });
});
