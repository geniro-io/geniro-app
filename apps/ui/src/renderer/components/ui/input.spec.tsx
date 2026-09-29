// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Input } from './input';
import { Textarea } from './textarea';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container.firstElementChild as HTMLElement;
}

// iOS zooms the page into any focused field set below 16px, and the viewport
// does not cap the scale, so on a phone that zoom stays. The primitives keep
// 16px below `sm` whatever size a caller asks for above it.
describe('text field primitives on a phone', () => {
  it('keeps an Input at 16px below sm when the caller shrinks it', () => {
    const field = render(<Input className="h-7 text-xs" />);

    expect(field.className).toContain('max-sm:text-base');
    expect(field.className).toContain('text-xs');
  });

  it('lets a caller’s own size hold at every width above sm', () => {
    // A breakpoint size in the base (`md:text-sm`) outranks a caller's plain
    // `text-xs` from md up, so a compact field grew back to 14px on a laptop.
    const field = render(<Input className="h-7 text-xs" />);

    expect(field.className).not.toMatch(/(^|\s)md:text-/);
    expect(field.className).not.toMatch(/(^|\s)text-sm(\s|$)/);
  });

  it('keeps a Textarea at 16px below sm when the caller shrinks it', () => {
    const field = render(<Textarea className="text-xs" />);

    expect(field.className).toContain('max-sm:text-base');
    expect(field.className).toMatch(/(^|\s)text-xs(\s|$)/);
    expect(field.className).not.toMatch(/(^|\s)md:text-/);
    expect(field.className).not.toMatch(/(^|\s)text-sm(\s|$)/);
  });
});
