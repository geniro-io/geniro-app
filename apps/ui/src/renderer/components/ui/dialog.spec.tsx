// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from './dialog';
import { Select } from './select';

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

describe('Dialog — pickers inside the scrolling body', () => {
  it('a picker opened inside it escapes the body it would be clipped by', () => {
    // The body scrolls (`overflow-y-auto`), so an absolutely-positioned menu is
    // cut at its edge — and `overflow-x: visible` cannot be restored on a box
    // that scrolls vertically. Reported as the run-configuration editor's
    // branch list being cut off. The dialog declares the clip so every picker
    // inside escapes it without being passed anything.
    act(() => {
      root.render(
        <Dialog open onClose={vi.fn()} title="Edit configuration">
          <Select
            groups={[{ items: [{ value: 'main', label: 'main' }] }]}
            value="main"
            aria-label="Branch"
            onValueChange={vi.fn()}
          />
        </Dialog>,
      );
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-menu-trigger]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const panel = document.querySelector<HTMLElement>(
      '[data-slot="menu-panel"]',
    )!;
    expect(panel.style.position).toBe('fixed');
  });

  it('gives the title slot the whole row, so a rich title can use its own edge', () => {
    // A title is not always a string — the task panel puts its whole header in
    // here and pushes the icon-only controls to the far edge with `ml-auto`.
    // A shrink-to-fit slot leaves that nothing to push into, and every control
    // stayed hugging the left with the card's width empty beside it: REPORTED
    // as "buttons still from left". jsdom computes no layout, so the class IS
    // the mechanism rather than a proxy for it.
    act(() => {
      root.render(
        <Dialog
          open
          onClose={vi.fn()}
          title={
            <div className="flex">
              <span>GEN-7</span>
              <button type="button" className="ml-auto">
                Open
              </button>
            </div>
          }>
          body
        </Dialog>,
      );
    });

    const slot = document.querySelector('[data-slot="dialog-title"]')!;
    expect(slot.className).toContain('flex-1');
    expect(slot.querySelector('button')?.className).toContain('ml-auto');
  });
});
