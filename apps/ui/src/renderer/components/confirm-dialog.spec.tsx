// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

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

type Props = React.ComponentProps<typeof ConfirmDialog>;

function render(props: Partial<Props> = {}): void {
  act(() => {
    root.render(
      <ConfirmDialog
        open={props.open ?? true}
        busy={props.busy ?? false}
        error={props.error ?? null}
        title={props.title ?? 'Delete workflow'}
        confirmLabel={props.confirmLabel ?? 'Delete'}
        busyLabel={props.busyLabel ?? 'Deleting…'}
        onCancel={props.onCancel ?? vi.fn()}
        onConfirm={props.onConfirm ?? vi.fn()}>
        {props.children ?? 'Delete Review Team permanently?'}
      </ConfirmDialog>,
    );
  });
}

/** Buttons live in the portal-less dialog rendered into our container. */
function button(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].find((el) => el.textContent?.trim() === label);
  if (!found) {
    throw new Error(`no "${label}" button (saw: ${container.textContent})`);
  }
  return found;
}

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ConfirmDialog', () => {
  it('renders nothing until opened', () => {
    render({ open: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the title, the consequence, and both choices', () => {
    render();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.textContent).toContain('Delete workflow');
    expect(container.textContent).toContain('Delete Review Team permanently?');
    expect(button('Cancel')).toBeTruthy();
    expect(button('Delete')).toBeTruthy();
  });

  it('fires the action only on the destructive button', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render({ onConfirm, onCancel });

    click(button('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    click(button('Delete'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons while the action is in flight', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render({ busy: true, onConfirm, onCancel });

    expect(button('Deleting…').disabled).toBe(true);
    expect(button('Cancel').disabled).toBe(true);
    click(button('Deleting…'));
    click(button('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ignores Escape while busy, so a half-done delete keeps its dialog', () => {
    const onCancel = vi.fn();
    render({ busy: true, onCancel });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('closes on Escape when idle', () => {
    const onCancel = vi.fn();
    render({ onCancel });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed action visible instead of pretending it worked', () => {
    render({ error: 'ENOENT: no such file' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'ENOENT: no such file',
    );
    expect(button('Delete')).toBeTruthy();
  });
});
