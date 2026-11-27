// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSettledValue } from './use-settled-value';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let seen: number[];

function Probe({ value }: { value: number }): null {
  seen.push(useSettledValue(value, 100, 0));
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  seen = [];
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useSettledValue', () => {
  it('answers the unsettled value until a reading has held for the delay', () => {
    act(() => root.render(<Probe value={3380} />));
    act(() => root.render(<Probe value={517} />));
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(seen.at(-1)).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(seen.at(-1)).toBe(517);
    expect(seen).not.toContain(3380);
  });

  it('keeps the last settled value while a new reading settles', () => {
    act(() => root.render(<Probe value={517} />));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    act(() => root.render(<Probe value={967} />));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(seen.at(-1)).toBe(517);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(seen.at(-1)).toBe(967);
  });
});
