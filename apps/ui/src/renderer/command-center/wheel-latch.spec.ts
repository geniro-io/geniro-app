import { describe, expect, it } from 'vitest';

import { latchWheel, WHEEL_LATCH_GAP_MS, wheelStep } from './wheel-latch';

const LIMITS = { minZoom: 0.25, maxZoom: 1.5 };

describe('latchWheel', () => {
  it('gives a rested wheel to what it starts over', () => {
    expect(latchWheel(null, 1000, true)).toEqual({
      owner: 'graph',
      until: 1000 + WHEEL_LATCH_GAP_MS,
    });
    expect(latchWheel(null, 1000, false).owner).toBe('other');
  });

  it('keeps a running gesture with its owner wherever the pointer goes, and lets it go once the wheel rests', () => {
    const started = latchWheel(null, 1000, true);
    const crossed = latchWheel(started, 1100, false);
    expect(crossed.owner).toBe('graph');
    expect(latchWheel(crossed, 1100 + WHEEL_LATCH_GAP_MS, false).owner).toBe(
      'graph',
    );
    expect(
      latchWheel(crossed, 1100 + WHEEL_LATCH_GAP_MS + 1, false).owner,
    ).toBe('other');
  });
});

describe('wheelStep', () => {
  const view = { x: 100, y: 50, zoom: 1 };

  it('pans by the wheel’s deltas, line steps counted as pixels', () => {
    expect(
      wheelStep(
        view,
        { deltaX: 10, deltaY: -20, deltaMode: 0, ctrlKey: false },
        { x: 0, y: 0 },
        LIMITS,
      ),
    ).toEqual({ x: 90, y: 70, zoom: 1 });
    expect(
      wheelStep(
        view,
        { deltaX: 0, deltaY: 2, deltaMode: 1, ctrlKey: false },
        { x: 0, y: 0 },
        LIMITS,
      ),
    ).toEqual({ x: 100, y: 18, zoom: 1 });
  });

  it('zooms a pinch about the pointer, so the point under it stays put', () => {
    const pointer = { x: 400, y: 300 };
    const next = wheelStep(
      view,
      { deltaX: 0, deltaY: -10, deltaMode: 0, ctrlKey: true },
      pointer,
      LIMITS,
    );
    expect(next.zoom).toBeGreaterThan(1);
    const before = (pointer.x - view.x) / view.zoom;
    const after = (pointer.x - next.x) / next.zoom;
    expect(after).toBeCloseTo(before, 6);
  });

  it('never zooms past the graph’s limits', () => {
    expect(
      wheelStep(
        view,
        { deltaX: 0, deltaY: -10_000, deltaMode: 0, ctrlKey: true },
        { x: 0, y: 0 },
        LIMITS,
      ).zoom,
    ).toBe(1.5);
    expect(
      wheelStep(
        view,
        { deltaX: 0, deltaY: 10_000, deltaMode: 0, ctrlKey: true },
        { x: 0, y: 0 },
        LIMITS,
      ).zoom,
    ).toBe(0.25);
  });
});
