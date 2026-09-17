// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineRenameInput } from './inline-rename-input';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(
  props: Partial<React.ComponentProps<typeof InlineRenameInput>> = {},
): Promise<{
  field: HTMLInputElement;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}> {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <InlineRenameInput
        value="app"
        ariaLabel="Rename"
        onCommit={onCommit}
        onCancel={onCancel}
        {...props}
      />,
    );
  });
  return { field: container.querySelector('input')!, onCommit, onCancel };
}

/** React tracks an input's value itself; set it the way a keystroke would. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(input: HTMLInputElement, init: KeyboardEventInit): void {
  input.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  );
}

describe('InlineRenameInput', () => {
  it('opens focused with the current name selected', async () => {
    const { field } = await mount();

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(3);
  });

  it('saves on Enter', async () => {
    const { field, onCommit } = await mount();

    act(() => type(field, 'dev server'));
    act(() => press(field, { key: 'Enter' }));

    expect(onCommit).toHaveBeenCalledWith('dev server');
  });

  it('saves on leaving the field', async () => {
    const { field, onCommit } = await mount();

    act(() => type(field, 'dev server'));
    act(() => field.blur());

    expect(onCommit).toHaveBeenCalledWith('dev server');
  });

  it('abandons the draft on Escape', async () => {
    const { field, onCommit, onCancel } = await mount();

    act(() => type(field, 'abandoned'));
    act(() => press(field, { key: 'Escape' }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('treats an unchanged name as a cancel, not a save', async () => {
    const { field, onCommit, onCancel } = await mount();

    act(() => type(field, ' app '));
    act(() => press(field, { key: 'Enter' }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('does not save on the Enter that confirms an IME composition', async () => {
    const { field, onCommit, onCancel } = await mount();

    act(() => type(field, 'назв'));
    act(() => press(field, { key: 'Enter', isComposing: true }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps its keys from reaching the row around it', async () => {
    const onRowKey = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <div onKeyDown={onRowKey}>
          <InlineRenameInput
            value="app"
            ariaLabel="Rename"
            onCommit={() => undefined}
            onCancel={() => undefined}
          />
        </div>,
      );
    });

    act(() => press(container.querySelector('input')!, { key: 'a' }));

    expect(onRowKey).not.toHaveBeenCalled();
  });

  it('passes its length limit to the field', async () => {
    const { field } = await mount({ maxLength: 60 });

    expect(field.maxLength).toBe(60);
  });
});
