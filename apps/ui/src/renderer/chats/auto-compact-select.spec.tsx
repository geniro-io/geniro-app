// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AutoCompactSelect } from './auto-compact-select';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function render(value: number | null): {
  el: HTMLDivElement;
  picked: (number | null)[];
} {
  const picked: (number | null)[] = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <AutoCompactSelect value={value} onChange={(p) => picked.push(p)} />,
    );
  });
  act(() => {
    container!.querySelector<HTMLButtonElement>('[data-menu-trigger]')!.click();
  });
  return { el: container, picked };
}

const rowLabels = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[role="option"]')].map(
    (row) =>
      row.querySelector('[data-slot="menu-item-label"]')?.textContent ?? '',
  );

describe('AutoCompactSelect', () => {
  it('offers the shared thresholds plus off, and reports a pick as a number or null', () => {
    const { el, picked } = render(null);
    expect(rowLabels(el)).toEqual([
      'at 50%',
      'at 60%',
      'at 70%',
      'at 80%',
      'at 90%',
      'off',
    ]);
    act(() => {
      [...el.querySelectorAll<HTMLElement>('[role="option"]')][3]!.click();
    });
    act(() => {
      el.querySelector<HTMLButtonElement>('[data-menu-trigger]')!.click();
    });
    act(() => {
      [...el.querySelectorAll<HTMLElement>('[role="option"]')]
        .find(
          (row) =>
            row.querySelector('[data-slot="menu-item-label"]')?.textContent ===
            'off',
        )!
        .click();
    });
    expect(picked).toEqual([80, null]);
  });

  it('adds a stored threshold outside the list back as a row, in order', () => {
    const { el } = render(75);
    expect(rowLabels(el)).toEqual([
      'at 50%',
      'at 60%',
      'at 70%',
      'at 75%',
      'at 80%',
      'at 90%',
      'off',
    ]);
  });
});
