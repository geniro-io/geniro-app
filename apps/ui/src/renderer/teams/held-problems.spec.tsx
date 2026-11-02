// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  HELD_PROBLEMS_SHOWN,
  type HeldProblem,
  HeldProblems,
} from './held-problems';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
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

function problems(count: number): HeldProblem[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `p${index}`,
    level: 'warning',
    message: `Problem ${index + 1}`,
  }));
}

function draw(count: number): void {
  act(() =>
    root.render(<HeldProblems problems={problems(count)} slot="held" />),
  );
}

function rows(): string[] {
  return [...container.querySelectorAll('li')].map(
    (row) => row.textContent ?? '',
  );
}

function toggle(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Show'),
  );
}

describe('HeldProblems', () => {
  it('scrolls its own list, so a long one cannot push the page below it away', () => {
    draw(3);
    const list = container.querySelector('[data-slot="held-problems-list"]')!;
    expect(list.className).toContain('overflow-y-auto');
    expect(list.className).toMatch(/max-h-/);
  });

  it('shows the first few of a long list and expands to all of them', () => {
    draw(24);
    expect(rows()).toHaveLength(HELD_PROBLEMS_SHOWN);
    expect(toggle()?.textContent).toBe('Show all 24');
    act(() => toggle()!.click());
    expect(rows()).toHaveLength(24);
    expect(toggle()?.textContent).toBe('Show fewer');
    act(() => toggle()!.click());
    expect(rows()).toHaveLength(HELD_PROBLEMS_SHOWN);
  });

  it('shows a list one past the cap whole, rather than hiding a single row', () => {
    draw(HELD_PROBLEMS_SHOWN + 1);
    expect(rows()).toHaveLength(HELD_PROBLEMS_SHOWN + 1);
    expect(toggle()).toBeUndefined();
  });
});
