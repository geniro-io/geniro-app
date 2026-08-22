import { describe, expect, it, vi } from 'vitest';

import { revealWithinBox, scrollToBottom } from './scroll-to-bottom';

describe('scrollToBottom', () => {
  it('drives the box to its own full scroll height', () => {
    const scrollTo = vi.fn();
    scrollToBottom({ scrollHeight: 4000, scrollTo }, 'auto');
    expect(scrollTo).toHaveBeenCalledWith({ top: 4000, behavior: 'auto' });
  });

  it('passes the behaviour through', () => {
    const scrollTo = vi.fn();
    scrollToBottom({ scrollHeight: 120, scrollTo }, 'smooth');
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
