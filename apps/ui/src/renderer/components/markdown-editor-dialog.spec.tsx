// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real editor pulls in the whole remark/rehype stack and a stylesheet —
// far more than this spec needs. Stub it down to the one thing the dialog
// contracts on: a controlled value + an onChange.
vi.mock('./ui/md-editor', () => ({
  MdEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange?: (next: string) => void;
  }) => (
    <textarea
      data-testid="md-editor"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

import { MarkdownEditorDialog } from './markdown-editor-dialog';

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

type Props = React.ComponentProps<typeof MarkdownEditorDialog>;

function render(props: Partial<Props> = {}): void {
  const merged: Props = {
    open: true,
    title: 'Role / system prompt',
    value: 'original',
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...props,
  };
  act(() => {
    root.render(<MarkdownEditorDialog {...merged} />);
  });
}

function editor(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(
    '[data-testid="md-editor"]',
  );
  if (!el) {
    throw new Error(`no editor rendered (saw: ${container.textContent})`);
  }
  return el;
}

function type(el: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

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

describe('MarkdownEditorDialog', () => {
  it('renders nothing until opened', () => {
    render({ open: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens on the current value, titled by the field it edits', () => {
    render({ value: 'You are the Reviewer.' });
    expect(container.textContent).toContain('Role / system prompt');
    expect(editor().value).toBe('You are the Reviewer.');
  });

  it('STAGES edits — nothing reaches the field until Save', () => {
    // The whole point of a popup editor: you can rewrite a prompt freely and
    // still back out. If typing wired straight through to onSave/onChange,
    // Cancel could not undo anything.
    const onSave = vi.fn();
    render({ value: 'original', onSave });

    type(editor(), 'rewritten');
    expect(onSave).not.toHaveBeenCalled();

    click(button('Save'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('rewritten');
  });

  it('Cancel abandons the draft without reporting it', () => {
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render({ value: 'original', onSave, onCancel });

    type(editor(), 'scrapped');
    click(button('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('reopens on the caller value, never a previous visit’s abandoned draft', () => {
    render({ value: 'original' });
    type(editor(), 'abandoned');

    render({ open: false, value: 'original' });
    render({ open: true, value: 'original' });
    expect(editor().value).toBe('original');
  });

  it('reopens on a value changed elsewhere while it was closed', () => {
    render({ value: 'original' });
    render({ open: false, value: 'original' });
    render({ open: true, value: 'edited inline' });
    expect(editor().value).toBe('edited inline');
  });
});
