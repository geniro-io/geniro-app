// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmButton } from './confirm-button';

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
  vi.useRealTimers();
});

function render(onConfirm: () => void | Promise<void>): void {
  act(() => {
    root.render(
      <ConfirmButton onConfirm={onConfirm} confirmLabel="Sure?">
        Delete
      </ConfirmButton>,
    );
  });
}

function click(): void {
  act(() => {
    container
      .querySelector('button')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ConfirmButton', () => {
  it('arms on the first click and fires only on the second', () => {
    const onConfirm = vi.fn();
    render(onConfirm);

    click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Sure?');

    click();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Delete');
  });

  it('LOOKS armed, not merely reads armed', () => {
    // The word swapping to "Sure?" is half the signal; the colour is the half
    // a reader takes in without reading. Both matter because the builder's
    // Delete button passed `variant="destructive"`, which painted the RESTING
    // state the armed colour — so arming it changed nothing but the label, and
    // the guard silently stopped guarding. That prop is now excluded at the
    // type level; this is the behaviour that exclusion protects.
    const onConfirm = vi.fn();
    render(onConfirm);

    const button = container.querySelector('button')!;
    const resting = button.className;
    expect(resting).not.toContain('bg-destructive');

    click();
    expect(button.className).not.toBe(resting);
    expect(button.className).toContain('bg-destructive');
  });

  it('disarms after the window elapses without firing', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(onConfirm);

    click();
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(container.textContent).toContain('Delete');

    click(); // this is a fresh FIRST click — it must arm again, not fire
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('stays disabled while the confirmed action is in flight (no double-fire)', async () => {
    let resolveAction!: () => void;
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        }),
    );
    render(onConfirm);

    click();
    click(); // fires; promise pending
    expect(container.querySelector('button')?.disabled).toBe(true);
    click(); // ignored while busy
    expect(onConfirm).toHaveBeenCalledOnce();

    await act(async () => {
      resolveAction();
    });
    expect(container.querySelector('button')?.disabled).toBe(false);
  });
});
