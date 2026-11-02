// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmActionButton } from './confirm-action-button';

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

const dialog = (): Element | null =>
  document.body.querySelector('[role="dialog"]');

function dialogButton(text: string): HTMLButtonElement {
  return [...(dialog()?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent?.trim() === text,
  )!;
}

function render(onConfirm: () => Promise<void>): void {
  act(() => {
    root.render(
      <ConfirmActionButton
        question="Remove this worktree?"
        description="Its branch is kept."
        confirmLabel="Remove"
        busyLabel="Removing…"
        onConfirm={onConfirm}>
        Remove
      </ConfirmActionButton>,
    );
  });
}

async function press(): Promise<void> {
  await act(async () => container.querySelector('button')!.click());
}

describe('ConfirmActionButton', () => {
  it('asks in a dialog first and runs nothing until Confirm', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(onConfirm);

    await press();

    expect(dialog()?.textContent).toContain('Remove this worktree?');
    expect(dialog()?.textContent).toContain('Its branch is kept.');
    expect(onConfirm).not.toHaveBeenCalled();

    await act(async () => dialogButton('Remove').click());

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it('runs nothing when cancelled', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(onConfirm);

    await press();
    await act(async () => dialogButton('Cancel').click());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('keeps the dialog up with the reason when the action fails', async () => {
    render(async () => {
      throw new Error('It holds unsaved work.');
    });

    await press();
    await act(async () => dialogButton('Remove').click());

    expect(dialog()?.textContent).toContain('It holds unsaved work.');
  });
});
