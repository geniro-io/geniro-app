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

/**
 * Escape belongs to ONE dialog — the one on top.
 *
 * With a `document` listener per dialog, every open dialog would close on
 * every Escape: the ⤢ editor opened from inside the New task dialog would
 * take the New task dialog down with it — and a label field's Escape
 * ("abandon this label") would close the whole form around it, draft and all.
 */
describe('Dialog — Escape', () => {
  function Stack({
    inner,
    onOuterClose,
    onInnerClose,
  }: {
    inner: boolean;
    onOuterClose: () => void;
    onInnerClose: () => void;
  }): React.JSX.Element {
    return (
      <Dialog open onClose={onOuterClose} title="New task">
        <input aria-label="Outer field" />
        <Dialog open={inner} onClose={onInnerClose} title="Description">
          <input aria-label="Inner field" />
        </Dialog>
      </Dialog>
    );
  }

  const escapeFrom = (target: Element | null): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      (target ?? document.body).dispatchEvent(event);
    });
    return event;
  };

  it('closes only the dialog on TOP when one is open over another', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    // The outer is open first and the inner opened over it — the order a user
    // produces by pressing ⤢ inside a form.
    act(() => {
      root.render(
        <Stack inner={false} onOuterClose={outer} onInnerClose={inner} />,
      );
    });
    act(() => {
      root.render(<Stack inner onOuterClose={outer} onInnerClose={inner} />);
    });

    escapeFrom(document.activeElement);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('keeps the inner dialog on top when the outer re-renders with a new onClose', () => {
    // Callers pass inline arrows, so every render of the surrounding screen
    // hands the outer dialog a new `onClose`. Re-registering on that identity
    // change would move the outer dialog back to the top of the stack.
    const inner = vi.fn();
    const firstOuter = vi.fn();
    const secondOuter = vi.fn();
    act(() => {
      root.render(
        <Stack inner={false} onOuterClose={firstOuter} onInnerClose={inner} />,
      );
    });
    act(() => {
      root.render(
        <Stack inner onOuterClose={firstOuter} onInnerClose={inner} />,
      );
    });
    act(() => {
      root.render(
        <Stack inner onOuterClose={secondOuter} onInnerClose={inner} />,
      );
    });

    escapeFrom(document.activeElement);

    expect(inner).toHaveBeenCalledTimes(1);
    expect(firstOuter).not.toHaveBeenCalled();
    expect(secondOuter).not.toHaveBeenCalled();
  });

  it('hands Escape back to the dialog below once the top one has closed', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    act(() => {
      root.render(
        <Stack inner={false} onOuterClose={outer} onInnerClose={inner} />,
      );
    });
    act(() => {
      root.render(<Stack inner onOuterClose={outer} onInnerClose={inner} />);
    });
    act(() => {
      root.render(
        <Stack inner={false} onOuterClose={outer} onInnerClose={inner} />,
      );
    });

    escapeFrom(document.activeElement);

    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it('calls the LATEST onClose it was given', () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => {
      root.render(
        <Dialog open onClose={first} title="Rename chat">
          body
        </Dialog>,
      );
    });
    act(() => {
      root.render(
        <Dialog open onClose={second} title="Rename chat">
          body
        </Dialog>,
      );
    });

    escapeFrom(document.body);

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('leaves an Escape a control inside it already handled alone', () => {
    // A control that owns the key says so with `preventDefault` — the same
    // contract `menu.tsx`'s `consume()` follows. Closing anyway made that
    // control's own Escape (abandon THIS edit) cost the whole dialog.
    const onClose = vi.fn();
    act(() => {
      root.render(
        <Dialog open onClose={onClose} title="New task">
          <input
            aria-label="Owns Escape"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
              }
            }}
          />
        </Dialog>,
      );
    });

    escapeFrom(document.querySelector('[aria-label="Owns Escape"]'));

    expect(onClose).not.toHaveBeenCalled();
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
