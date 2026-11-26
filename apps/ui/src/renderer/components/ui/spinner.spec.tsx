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

function draw(node: React.ReactNode): SVGElement {
  act(() => root.render(node));
  return container.querySelector('svg')!;
}

describe('Spinner', () => {
  it('spins a smooth arc by default', () => {
    const svg = draw(<Spinner />);
    expect(svg.classList.contains('animate-spin')).toBe(true);
    expect(svg.classList.contains('spinner-stepped')).toBe(false);
    expect(svg.classList.contains('lucide-loader-circle')).toBe(true);
  });

  it('turns a spoked wheel in steps when stepped', () => {
    const svg = draw(<Spinner pace="stepped" className="size-4" />);
    expect(svg.classList.contains('animate-spin')).toBe(true);
    expect(svg.classList.contains('spinner-stepped')).toBe(true);
    expect(svg.classList.contains('lucide-loader')).toBe(true);
    expect(svg.classList.contains('size-4')).toBe(true);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
