import { describe, expect, it } from 'vitest';

import {
  isScrolledToBottom,
  nextFollowState,
  shouldLoadOlder,
} from './scroll-follow';

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

describe('shouldLoadOlder', () => {
  /** 1000px of scroll range, so the 0.3 threshold sits at scrollTop 300. */
  const at = (scrollTop: number) => ({
    scrollTop,
    scrollHeight: 1400,
    clientHeight: 400,
  });

  it('pages while the reader is scrolling UP through the top of the window', () => {
    expect(shouldLoadOlder(at(250), 400)).toBe(true);
    expect(shouldLoadOlder(at(0), 120)).toBe(true);
  });

  it('pages for a reader who has come to rest up there', () => {
    // Momentum ends and the frames stop; `scrollTop` equals the previous one.
    // Still looking at history, so the next page is still wanted.
    expect(shouldLoadOlder(at(200), 200)).toBe(true);
  });

  it('does not page below the threshold, however the viewport got there', () => {
    expect(shouldLoadOlder(at(301), 900)).toBe(false);
    expect(shouldLoadOlder(at(1000), 1000)).toBe(false);
  });

  // THE regression this function exists for. Pressing "Latest" animates the
  // viewport down, and the early frames of that animation are still inside the
  // threshold — so the pager fired mid-flight and the caller then held the
  // reader's place with a `scrollTop` write, which terminates a smooth scroll.
  // Measured in the running app on a 9,000-item thread: 147,312px of transcript
  // fetched during ONE press, and the animation replaced by a teleport. It did
  // not strand the reader — the press re-arms the follow, so the growth it
  // caused re-followed the tail — so what this guard buys is the fetch and the
  // animation, not the destination.
  it('does not page during the frames of a jump DOWN to the latest message', () => {
    expect(shouldLoadOlder(at(40), 0)).toBe(false);
    expect(shouldLoadOlder(at(180), 40)).toBe(false);
    expect(shouldLoadOlder(at(299), 180)).toBe(false);
  });

  it('does not cascade off the place-holding write that follows a page', () => {
    // Prepending rows pushes the reader down by the height that arrived, and
    // the caller restores it with `scrollTop += `. That emits a `scroll` of its
    // own, moving DOWN — which must not immediately ask for the page after it.
    expect(shouldLoadOlder(at(260), 60)).toBe(false);
  });
});
