// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Spinner } from './spinner';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function draw(node: React.ReactNode): Element {
  act(() => root.render(node));
  return container.firstElementChild!;
}

describe('Spinner', () => {
  it('spins a smooth arc by default', () => {
    const svg = draw(<Spinner />);
    expect(svg.classList.contains('animate-spin')).toBe(true);
    expect(svg.classList.contains('spinner-stepped')).toBe(false);
    expect(svg.classList.contains('lucide-loader-circle')).toBe(true);
  });

  it('turns a span around a spoked wheel in steps when stepped, never the svg itself', () => {
    const spinner = draw(<Spinner pace="stepped" className="size-4" />);
    expect(spinner.tagName).toBe('SPAN');
    expect(spinner.classList.contains('animate-spin')).toBe(true);
    expect(spinner.classList.contains('spinner-stepped')).toBe(true);
    expect(spinner.classList.contains('size-4')).toBe(true);
    expect(spinner.getAttribute('aria-hidden')).toBe('true');
    const glyph = spinner.querySelector('svg')!;
    expect(glyph.classList.contains('lucide-loader')).toBe(true);
    expect(glyph.classList.contains('animate-spin')).toBe(false);
  });
});
