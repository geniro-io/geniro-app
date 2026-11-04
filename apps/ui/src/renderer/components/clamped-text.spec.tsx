// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClampedText } from './clamped-text';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function cutText(cut: boolean): void {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(
    cut ? 200 : 40,
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ClampedText', () => {
  it('opens the whole text elsewhere when given onOpen, never unfolding it in place', () => {
    cutText(true);
    const onOpen = vi.fn();
    act(() => {
      root.render(
        <ClampedText text="long" lines={4} slot="body" onOpen={onOpen} />,
      );
    });

    const toggle = container.querySelector('button')!;
    expect(toggle.textContent).toBe('Open full text');
    act(() => toggle.click());

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-slot="body"]')!.className).toContain(
      'line-clamp-4',
    );
  });

  it('unfolds in place without onOpen', () => {
    cutText(true);
    act(() => {
      root.render(<ClampedText text="long" lines={2} slot="body" />);
    });

    act(() => container.querySelector('button')!.click());

    expect(
      container.querySelector('[data-slot="body"]')!.className,
    ).not.toContain('line-clamp');
    expect(container.querySelector('button')!.textContent).toBe('Show less');
  });

  it('offers nothing when the text is not cut', () => {
    cutText(false);
    act(() => {
      root.render(
        <ClampedText text="short" lines={4} slot="body" onOpen={vi.fn()} />,
      );
    });

    expect(container.querySelector('button')).toBeNull();
  });
});
