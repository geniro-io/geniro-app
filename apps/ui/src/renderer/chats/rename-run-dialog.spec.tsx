// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RenameRunDialog } from './rename-run-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const baseProps = {
  open: true,
  busy: false,
  initial: 'My chat',
  onClose: vi.fn(),
  onSubmit: vi.fn(),
};

describe('RenameRunDialog', () => {
  it('prefills the current label and submits the trimmed new title', () => {
    const onSubmit = vi.fn();
    const el = render(<RenameRunDialog {...baseProps} onSubmit={onSubmit} />);
    const input = el.querySelector<HTMLInputElement>('#chat-rename-title')!;
    expect(input.value).toBe('My chat');

    act(() => setValue(input, '  Auth refactor  '));
    act(() => {
      el.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onSubmit).toHaveBeenCalledWith('Auth refactor');
  });

  it('refuses to submit a blank title', () => {
    const onSubmit = vi.fn();
    const el = render(<RenameRunDialog {...baseProps} onSubmit={onSubmit} />);
    act(() =>
      setValue(el.querySelector<HTMLInputElement>('#chat-rename-title')!, '  '),
    );
    act(() => {
      el.querySelector('form')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('a reopened dialog resets to the (new) initial, not the abandoned draft', () => {
    const el = render(<RenameRunDialog {...baseProps} />);
    act(() =>
      setValue(
        el.querySelector<HTMLInputElement>('#chat-rename-title')!,
        'abandoned draft',
      ),
    );
    rerender(<RenameRunDialog {...baseProps} open={false} />);
    rerender(<RenameRunDialog {...baseProps} initial="Other run" />);
    expect(
      el.querySelector<HTMLInputElement>('#chat-rename-title')!.value,
    ).toBe('Other run');
  });

  it('shows the error and the busy label', () => {
    const el = render(
      <RenameRunDialog {...baseProps} busy error="daemon PATCH failed (500)" />,
    );
    expect(el.textContent).toContain('daemon PATCH failed (500)');
    expect(el.textContent).toContain('Saving…');
  });
});
