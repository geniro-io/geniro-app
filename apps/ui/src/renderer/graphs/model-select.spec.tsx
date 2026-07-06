// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelSelect } from './model-select';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactNode): void {
  act(() => {
    root.render(element);
  });
}

function select(): HTMLSelectElement {
  return container.querySelector('select')!;
}

function customInput(): HTMLInputElement | null {
  return container.querySelector('input');
}

/** Change a controlled element through the prototype setter so React's value
 *  tracking sees it (the repo-wide idiom — see Chats.spec.tsx). */
function change(
  el: HTMLSelectElement | HTMLInputElement,
  value: string,
  event: 'change' | 'input',
): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event(event, { bubbles: true }));
  });
}

describe('ModelSelect', () => {
  it('lists CLI default + the agent aliases + Custom, per agent kind', () => {
    render(<ModelSelect id="m" agent="claude" value="" onChange={() => {}} />);
    const labels = [...select().options].map((o) => o.textContent);
    expect(labels).toEqual([
      'CLI default',
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'Custom…',
    ]);
    expect(select().value).toBe('');
    expect(customInput()).toBeNull();

    render(
      <ModelSelect id="m" agent="cursor-agent" value="" onChange={() => {}} />,
    );
    const cursorLabels = [...select().options].map((o) => o.textContent);
    expect(cursorLabels).toEqual([
      'CLI default',
      'gpt-5',
      'sonnet-4',
      'sonnet-4-thinking',
      'Custom…',
    ]);
  });

  it('picking an alias emits it; picking CLI default emits undefined', () => {
    const onChange = vi.fn();
    render(<ModelSelect id="m" agent="claude" value="" onChange={onChange} />);
    change(select(), 'opus', 'change');
    expect(onChange).toHaveBeenLastCalledWith('opus');
    change(select(), '', 'change');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('an off-list stored model starts in custom mode showing the exact value', () => {
    render(
      <ModelSelect
        id="m"
        agent="claude"
        value="claude-fable-5"
        onChange={() => {}}
      />,
    );
    expect(select().value).toBe('__custom__');
    expect(customInput()?.value).toBe('claude-fable-5');
  });

  it('Custom… opens free-text entry without erasing the stored model', () => {
    const onChange = vi.fn();
    render(
      <ModelSelect id="m" agent="claude" value="opus" onChange={onChange} />,
    );
    change(select(), '__custom__', 'change');
    // Switching modes alone must not touch the node — only typing does.
    expect(onChange).not.toHaveBeenCalled();
    expect(customInput()?.value).toBe('opus');

    change(customInput()!, 'claude-fable-5', 'input');
    expect(onChange).toHaveBeenLastCalledWith('claude-fable-5');
    change(customInput()!, '', 'input');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('leaving custom mode via an alias emits the alias and hides the input', () => {
    const onChange = vi.fn();
    render(
      <ModelSelect
        id="m"
        agent="claude"
        value="my-custom-model"
        onChange={onChange}
      />,
    );
    change(select(), 'sonnet', 'change');
    expect(onChange).toHaveBeenLastCalledWith('sonnet');
    expect(customInput()).toBeNull();
  });
});
