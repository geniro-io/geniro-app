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

/**
 * jsdom computes no layout, so `scrollHeight` is 0 for everything. Standing one
 * in is what makes the growth observable at all — it is the ONE measurement the
 * component takes off the element, and everything else it does is arithmetic on
 * the computed style, which jsdom does provide.
 *
 * It is deliberately not a constant: a real `scrollHeight` never reports LESS
 * than the element's own height, which is the whole reason the component
 * collapses the box before reading it. A stub that ignored the inline height
 * would let that collapse be deleted with every test still passing.
 */
function withContentHeight(px: number): () => void {
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      const set = Number.parseFloat(this.style.height);
      return Math.max(px, Number.isFinite(set) ? set : 0);
    },
  });
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)
        .scrollHeight;
    }
  };
}

/** The line box every height expectation is counted in — jsdom's 16px default. */
const LINE = 16 * 1.5;

/** One field with the sizing props under test, rendered on its own. */
function renderSized(props: {
  rows: number;
  maxRows?: number;
  value: string;
}): HTMLTextAreaElement {
  act(() => {
    root.render(
      <ExpandableTextarea
        id="node-role"
        title="Role / system prompt"
        onChange={vi.fn()}
        {...props}
      />,
    );
  });
  return inlineField();
}

describe('ExpandableTextarea — how tall it is', () => {
  it('grows to fit its text instead of scrolling inside a fixed box', () => {
    // REPORTED against the graph inspector's Description: a four-line value cut
    // mid-word inside a box three lines tall, the rest reachable only by
    // scrolling. The height used to say how much room the CALL SITE guessed the
    // text would need.
    const restore = withContentHeight(5 * LINE);
    try {
      const field = renderSized({ rows: 3, value: 'a\nb\nc\nd\ne' });

      expect(field.style.height).toBe(`${5 * LINE}px`);
    } finally {
      restore();
    }
  });

  it('stops growing at maxRows and lets the field scroll from there', () => {
    // The other half: without a cap a long role prompt pushes every control
    // under it off the panel, which is what the fixed height was protecting
    // against. Past the cap the field scrolls exactly as it always did.
    const restore = withContentHeight(40 * LINE);
    try {
      const field = renderSized({
        rows: 3,
        maxRows: 10,
        value: 'x\n'.repeat(40),
      });

      expect(field.style.height).toBe(`${10 * LINE}px`);
    } finally {
      restore();
    }
  });

  it('treats `rows` as the FLOOR, so an empty field still looks like a field', () => {
    // A box that shrank to its content would leave an untouched Description one
    // line tall — a text input, not a place a paragraph is expected.
    const restore = withContentHeight(LINE);
    try {
      const field = renderSized({ rows: 4, value: '' });

      expect(field.style.height).toBe(`${4 * LINE}px`);
    } finally {
      restore();
    }
  });

  it('SHRINKS again when the text does', () => {
    // `scrollHeight` never reports less than the element's own height, so a
    // field measured without collapsing it first can only ever grow — one long
    // paste and it stays tall for the rest of the session.
    const tall = withContentHeight(8 * LINE);
    let field: HTMLTextAreaElement;
    try {
      field = renderSized({ rows: 3, value: 'x\n'.repeat(8) });
      expect(field.style.height).toBe(`${8 * LINE}px`);
    } finally {
      tall();
    }

    const short = withContentHeight(LINE);
    try {
      renderSized({ rows: 3, value: 'x' });

      expect(field.style.height).toBe(`${3 * LINE}px`);
    } finally {
      short();
    }
  });
});
