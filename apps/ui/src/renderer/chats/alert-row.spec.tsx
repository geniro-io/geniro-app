// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AlertRow } from './alert-row';

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

const MESSAGE = 'spawn cursor-agent ENOENT\nfull stderr line 2\nline 3';

describe('AlertRow', () => {
  it('wears the destructive tone and collapses to the first line by default', () => {
    act(() =>
      root.render(<AlertRow caption="flaky · error" message={MESSAGE} />),
    );

    const row = container.querySelector('[data-role="error"]');
    expect(row).not.toBeNull();
    expect(row?.className).toContain('destructive');
    expect(container.textContent).toContain('spawn cursor-agent ENOENT');
    expect(container.textContent).not.toContain('full stderr line 2');
  });

  it('a click expands the FULL message; a second click collapses it again', () => {
    act(() =>
      root.render(<AlertRow caption="flaky · error" message={MESSAGE} />),
    );
    const toggle = container.querySelector('button[aria-expanded]')!;

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('full stderr line 2');
    expect(container.textContent).toContain('line 3');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('full stderr line 2');
  });
});
