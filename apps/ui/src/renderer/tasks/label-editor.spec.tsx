// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LabelEditor } from './label-editor';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function editor(
  labels: string[],
  suggestions: readonly string[] = [],
): {
  el: HTMLDivElement;
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LabelEditor
        labels={labels}
        suggestions={suggestions}
        onChange={onChange}
      />,
    );
  });
  return { el: container, onChange };
}

const addButton = (el: HTMLElement): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((node) =>
    (node.textContent ?? '').includes('Label'),
  ) as HTMLButtonElement;

const field = (el: HTMLElement): HTMLInputElement =>
  el.querySelector('input[aria-label="New label"]') as HTMLInputElement;

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('LabelEditor', () => {
  it('adds a typed label on Enter', () => {
    const { el, onChange } = editor(['design']);
    act(() => {
      addButton(el).click();
    });

    act(() => {
      type(field(el), 'infra');
    });
    act(() => {
      field(el).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onChange).toHaveBeenCalledWith(['design', 'infra']);
  });

  it('abandons on Escape, and does not bring the text back next time', () => {
    // The draft lives in this component's state, which OUTLIVES the field —
    // Escape unmounts the input but the string would survive it, so re-opening
    // would hand the user back the label they just backed out of.
    const { el, onChange } = editor([]);
    act(() => {
      addButton(el).click();
    });
    act(() => {
      type(field(el), 'oops');
    });

    act(() => {
      field(el).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      addButton(el).click();
    });

    expect(field(el).value).toBe('');
  });

  it('ignores a duplicate instead of refusing it', () => {
    // The label is already on the task, so the user's intent is already met.
    const { el, onChange } = editor(['design']);
    act(() => {
      addButton(el).click();
    });
    act(() => {
      type(field(el), 'design');
    });
    act(() => {
      field(el).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes the label its × belongs to', () => {
    const { el, onChange } = editor(['design', 'infra']);

    const remove = [...el.querySelectorAll('button')].find(
      (node) => node.getAttribute('aria-label') === 'Remove label infra',
    ) as HTMLButtonElement;
    act(() => {
      remove.click();
    });

    expect(onChange).toHaveBeenCalledWith(['design']);
  });

  it('stops offering more labels at the daemon’s own cap', () => {
    // Twenty is TASK_LABELS_MAX. Offering a 21st would earn a red banner from
    // the route rather than a validation message here.
    const { el } = editor(Array.from({ length: 20 }, (_, i) => `label-${i}`));

    expect(addButton(el)).toBeUndefined();
  });

  describe('the labels this board already uses', () => {
    const suggestion = (el: HTMLElement, label: string): HTMLButtonElement =>
      el.querySelector<HTMLButtonElement>(
        `[aria-label="Add label ${label}"]`,
      ) as HTMLButtonElement;

    const suggestions = (el: HTMLElement): string[] =>
      [...el.querySelectorAll('button')]
        .map((node) => node.getAttribute('aria-label') ?? '')
        .filter((name) => name.startsWith('Add label '))
        .map((name) => name.slice('Add label '.length));

    it('offers them only once the user has reached for + Label', () => {
      // A permanent row of them would be noise on every card; the moment
      // somebody wants one is the moment they pressed the button.
      const { el } = editor([], ['bug', 'ui']);
      expect(suggestions(el)).toEqual([]);

      act(() => {
        addButton(el).click();
      });

      expect(suggestions(el)).toEqual(['bug', 'ui']);
    });

    it('adds one on a press, without retyping it', () => {
      const { el, onChange } = editor(['design'], ['bug']);
      act(() => {
        addButton(el).click();
      });

      act(() => {
        suggestion(el, 'bug').click();
      });

      expect(onChange).toHaveBeenCalledWith(['design', 'bug']);
    });

    it('holds focus so the press is not eaten by the field’s own blur', () => {
      // `onBlur` commits and closes the editor, which unmounts the chip before
      // its click can land — so without the prevented mousedown the control
      // does nothing at all.
      const { el } = editor([], ['bug']);
      act(() => {
        addButton(el).click();
      });

      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        suggestion(el, 'bug').dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(true);
    });

    it('never offers a label the card already carries', () => {
      const { el } = editor(['bug'], ['bug', 'ui']);
      act(() => {
        addButton(el).click();
      });

      expect(suggestions(el)).toEqual(['ui']);
    });

    it('narrows to what has been typed, case-insensitively', () => {
      const { el } = editor([], ['bug', 'Backend', 'ui']);
      act(() => {
        addButton(el).click();
      });

      act(() => {
        type(field(el), 'B');
      });

      expect(suggestions(el)).toEqual(['bug', 'Backend']);
    });

    it('caps the row and SAYS how many it is withholding', () => {
      // A label that exists but is off screen must not read as one that does
      // not exist — the sentence is what points at typing as the way past it.
      const { el } = editor(
        [],
        Array.from({ length: 12 }, (_unused, i) => `label-${i}`),
      );
      act(() => {
        addButton(el).click();
      });

      expect(suggestions(el)).toHaveLength(8);
      expect(el.textContent).toContain('+4 more');
    });

    it('stays open after a press, so several can be added in a row', () => {
      const { el } = editor([], ['bug', 'ui']);
      act(() => {
        addButton(el).click();
      });

      act(() => {
        suggestion(el, 'bug').click();
      });

      expect(field(el)).not.toBeNull();
    });
  });
});
