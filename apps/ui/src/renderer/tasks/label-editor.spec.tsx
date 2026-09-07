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

function editor(labels: string[]): {
  el: HTMLDivElement;
  onChange: ReturnType<typeof vi.fn>;
} {
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<LabelEditor labels={labels} onChange={onChange} />);
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
});
