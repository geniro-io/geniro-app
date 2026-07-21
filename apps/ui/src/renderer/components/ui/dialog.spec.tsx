// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from './dialog';

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

function renderDialog(open: boolean, onClose = vi.fn()): void {
  act(() => {
    root.render(
      <>
        <button type="button" id="opener">
          Open
        </button>
        <Dialog open={open} onClose={onClose} title="Rename chat">
          <form>
            <input aria-label="Title" />
            <button type="submit">Save</button>
          </form>
        </Dialog>
      </>,
    );
  });
}

function pressTab(shiftKey = false): void {
  act(() => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true }),
    );
  });
}

describe('Dialog focus management', () => {
  it('moves initial focus to the first focusable child after the corner ✕', () => {
    renderDialog(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Title');
  });

  it('traps Tab inside the card in both directions', () => {
    renderDialog(true);
    const buttons = [...container.querySelectorAll('button')];
    const close = buttons.find(
      (b) => b.getAttribute('aria-label') === 'Close',
    )!;
    const save = buttons.find((b) => b.textContent === 'Save')!;

    // Forward from the LAST focusable wraps to the first (the ✕).
    act(() => save.focus());
    pressTab();
    expect(document.activeElement).toBe(close);

    // Shift+Tab from the FIRST focusable wraps to the last.
    pressTab(true);
    expect(document.activeElement).toBe(save);
  });

  it('restores focus to the opener on close', () => {
    renderDialog(false);
    const opener = container.querySelector<HTMLButtonElement>('#opener')!;
    act(() => opener.focus());

    renderDialog(true);
    expect(document.activeElement).not.toBe(opener);

    renderDialog(false);
    expect(document.activeElement).toBe(opener);
  });
});
