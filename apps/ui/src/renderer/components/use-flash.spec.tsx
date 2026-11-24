// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FLASH_WINDOW_MS, useFlash } from './use-flash';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let handle: ReturnType<typeof useFlash<'done' | 'failed'>>;

function Probe(): React.JSX.Element {
  handle = useFlash<'done' | 'failed'>();
  return <span>{handle.flash ?? 'none'}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function shown(): string {
  return container.textContent ?? '';
}

describe('useFlash', () => {
  it('shows a kind, then reverts once the window has passed', () => {
    act(() => handle.show('done'));
    expect(shown()).toBe('done');
    act(() => {
      vi.advanceTimersByTime(FLASH_WINDOW_MS - 1);
    });
    expect(shown()).toBe('done');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe('none');
  });

  it('restarts the window when shown again, so the second kind gets its full time', () => {
    act(() => handle.show('done'));
    act(() => {
      vi.advanceTimersByTime(FLASH_WINDOW_MS - 100);
    });
    act(() => handle.show('failed'));
    act(() => {
      vi.advanceTimersByTime(FLASH_WINDOW_MS - 1);
    });
    expect(shown()).toBe('failed');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(shown()).toBe('none');
  });

  it('drops a show that arrives after unmount and leaves no timer behind', () => {
    const show = handle.show;
    act(() => handle.show('done'));
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    show('failed');
    expect(vi.getTimerCount()).toBe(0);
    root = createRoot(container);
  });
});
