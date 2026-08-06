import { describe, expect, it } from 'vitest';

import { isScrolledToBottom, nextFollowState } from './scroll-follow';

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

describe('nextFollowState', () => {
  const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 500) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it('re-arms the follow as soon as the bottom is reached', () => {
    expect(nextFollowState(false, at(500), 200)).toBe(true);
  });

  // The regression that made the tail give up on itself: a smooth scroll fires
  // `scroll` for every frame of its animation, and each one is "not at the
  // bottom" yet. Reading only isScrolledToBottom switched following off during
  // the very animation that was taking us there.
  it('keeps following through the frames of a smooth scroll downwards', () => {
    expect(nextFollowState(true, at(300), 100)).toBe(true);
    expect(nextFollowState(true, at(420), 300)).toBe(true);
  });

  // The user's actual complaint: a thinking block fills in below the fold. The
  // bottom moves away while scrollTop stands still — through no act of theirs.
  it('keeps following when content grows without the viewport moving', () => {
    expect(nextFollowState(true, at(400, 2000), 400)).toBe(true);
  });

  it('stops following the moment the user scrolls up', () => {
    expect(nextFollowState(true, at(200), 400)).toBe(false);
  });

  it('stays off once the user has scrolled up, until they return to the bottom', () => {
    expect(nextFollowState(false, at(300), 300)).toBe(false);
    expect(nextFollowState(false, at(360), 300)).toBe(false);
    expect(nextFollowState(false, at(500), 460)).toBe(true);
  });
});
