// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// See markdown-editor-dialog.spec — the real editor is far heavier than this
// spec needs, so it is stubbed down to a controlled textarea.
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

import { ExpandableTextarea } from './expandable-textarea';

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

function render(onChange = vi.fn(), value = 'You are the Reviewer.'): void {
  act(() => {
    root.render(
      <ExpandableTextarea
        id="node-role"
        title="Role / system prompt"
        value={value}
        onChange={onChange}
      />,
    );
  });
}

function inlineField(): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>('#node-role');
  if (!el) {
    throw new Error('no inline textarea rendered');
  }
  return el;
}

function expandButton(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(
    '[aria-label="Expand Role / system prompt"]',
  );
  if (!el) {
    throw new Error('no expand button rendered');
  }
  return el;
}

function popupEditor(): HTMLTextAreaElement | null {
  return container.querySelector<HTMLTextAreaElement>(
    '[data-testid="md-editor"]',
  );
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

function click(el: HTMLElement): void {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>('button'),
  ].find((el) => el.textContent?.trim() === label);
  if (!found) {
    throw new Error(`no "${label}" button`);
  }
  return found;
}

describe('ExpandableTextarea', () => {
  it('edits inline like a plain textarea, reporting the text (not the event)', () => {
    const onChange = vi.fn();
    render(onChange);
    type(inlineField(), 'edited inline');
    expect(onChange).toHaveBeenCalledWith('edited inline');
  });

  it('keeps the popup closed until the expand button is pressed', () => {
    render();
    expect(popupEditor()).toBeNull();
    click(expandButton());
    expect(popupEditor()).not.toBeNull();
  });

  it('carries the current text into the popup', () => {
    render(vi.fn(), 'You are the Reviewer.');
    click(expandButton());
    expect(popupEditor()?.value).toBe('You are the Reviewer.');
  });

  it('applies a popup Save to the field and closes', () => {
    const onChange = vi.fn();
    render(onChange);
    click(expandButton());
    type(popupEditor()!, 'rewritten in the popup');
    click(button('Save'));

    expect(onChange).toHaveBeenCalledWith('rewritten in the popup');
    expect(popupEditor()).toBeNull();
  });

  it('discards a popup Cancel — the field is never told', () => {
    const onChange = vi.fn();
    render(onChange);
    click(expandButton());
    type(popupEditor()!, 'scrapped');
    click(button('Cancel'));

    expect(onChange).not.toHaveBeenCalled();
    expect(popupEditor()).toBeNull();
  });

  it('names the field on its expand button, so several in one panel stay distinct', () => {
    render();
    expect(expandButton().getAttribute('aria-label')).toBe(
      'Expand Role / system prompt',
    );
  });
});
