import { describe, expect, it, vi } from 'vitest';

import { followTail, jumpToBottom, revealWithinBox } from './scroll-to-bottom';

/**
 * A scroll box that models the ONE browser behaviour this module exists to get
 * right: `auto` lands immediately, `smooth` is an animation, and a second
 * animated call REPLACES the one still in flight rather than queueing behind
 * it. Measured in the running app — 53 smooth calls across one streaming turn
 * left `scrollTop` unchanged at 1404 while `scrollHeight` climbed to 3502.
 *
 * Modelled rather than asserted-on-the-argument because the argument is not the
 * point: what broke was that the viewport never arrived.
 */
function browserBox(scrollHeight: number, clientHeight = 500) {
  const box = {
    scrollHeight,
    scrollTop: 0,
    clientHeight,
    /** Set while an animation is in flight; a new call discards it. */
    animating: null as number | null,
    scrollTo(options: ScrollToOptions) {
      const target = Math.min(
        options.top ?? 0,
        box.scrollHeight - box.clientHeight,
      );
      if (options.behavior === 'smooth') {
        // Starts travelling; arrives only if left alone (see `settle`).
        box.animating = target;
        return;
      }
      box.animating = null;
      box.scrollTop = target;
    },
    /** The animation finally being left alone to finish. */
    settle() {
      if (box.animating !== null) {
        box.scrollTop = box.animating;
        box.animating = null;
      }
    },
    grow(by: number) {
      box.scrollHeight += by;
    },
    get distanceFromBottom() {
      return box.scrollHeight - box.scrollTop - box.clientHeight;
    },
  };
  return box;
}

describe('followTail', () => {
  it('lands on the bottom immediately', () => {
    const scrollTo = vi.fn();
    followTail({ scrollHeight: 4000, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: 4000, behavior: 'auto' });
  });

  it('KEEPS UP with a stream that re-issues it faster than an animation runs', () => {
    // The regression. Each chunk grows the transcript and asks to follow; an
    // animated follow would cancel its own predecessor every time and never
    // advance, which is what "it stays in one place while content piles up"
    // was. Landing immediately means every chunk leaves the viewport at the
    // tail, however fast they arrive.
    const box = browserBox(600);
    for (let chunk = 0; chunk < 30; chunk += 1) {
      box.grow(40);
      followTail(box);
    }
    expect(box.distanceFromBottom).toBe(0);
  });

  it('would NOT keep up if it animated — the failure this pins, made visible', () => {
    // The same 30 chunks through the animated path: every call replaces the one
    // in flight, so the box never moves until the stream stops. Written out so
    // the test above is a measurement rather than an assertion about a literal.
    const box = browserBox(600);
    for (let chunk = 0; chunk < 30; chunk += 1) {
      box.grow(40);
      jumpToBottom(box);
    }
    expect(box.scrollTop).toBe(0);
    expect(box.distanceFromBottom).toBe(1300);
    // …and only once nothing re-issues it does it finally arrive.
    box.settle();
    expect(box.distanceFromBottom).toBe(0);
  });
});

describe('jumpToBottom', () => {
  it('animates, because a single press is what the movement explains', () => {
    const scrollTo = vi.fn();
    jumpToBottom({ scrollHeight: 120, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: 120, behavior: 'smooth' });
  });
});

describe('revealWithinBox', () => {
  // A 200px box. The rows are 25px each, so row N starts at 25N.
  const box = (
    scrollTop: number,
  ): { scrollTop: number; clientHeight: number } => ({
    scrollTop,
    clientHeight: 200,
  });
  const row = (
    top: number,
    height = 25,
  ): { offsetTop: number; offsetHeight: number } => ({
    offsetTop: top,
    offsetHeight: height,
  });

  it('writes NOTHING for a row already in view', () => {
    // The half that keeps this from fighting the reader: a list somebody has
    // scrolled by hand must stay where they put it while the row they are
    // watching is still on screen.
    expect(revealWithinBox(box(0), row(0))).toBeNull();
    expect(revealWithinBox(box(0), row(175))).toBeNull();
    expect(revealWithinBox(box(100), row(100))).toBeNull();
  });

  it('brings a row BELOW the frame up by exactly its overshoot', () => {
    // Its bottom edge against the box's, so the row lands flush at the bottom
    // rather than being centred — the rows above it are the context.
    expect(revealWithinBox(box(0), row(300))).toBe(125);
    expect(revealWithinBox(box(50), row(300))).toBe(125);
  });

  it('brings a row ABOVE the frame back to its own top', () => {
    expect(revealWithinBox(box(200), row(75))).toBe(75);
  });

  it('shows a row TALLER than the box from its top, never past it', () => {
    // A task whose title wraps to more lines than the box holds. Scrolling to
    // its bottom edge would put its first line — the one naming the task —
    // above the frame.
    expect(revealWithinBox(box(0), row(100, 400))).toBe(100);
  });
});
