// @vitest-environment jsdom
import { act, useState } from 'react';
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

const spy = vi.fn();

/** Stateful parent mirroring the inspector: onChange feeds back into value,
 *  so the component's mount-adoption and custom-mode guards run for real. */
function Harness({ initial }: { initial?: string }): React.JSX.Element {
  const [model, setModel] = useState<string | undefined>(initial);
  return (
    <ModelSelect
      id="m"
      agent="claude"
      value={model ?? ''}
      onChange={(next) => {
        spy(next);
        setModel(next);
      }}
    />
  );
}

const trigger = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-menu-trigger]')!;

function customInput(): HTMLInputElement | null {
  return container.querySelector('input');
}

/** Open the menu, read its rows, close it again. */
function modelOptions(): string[] {
  act(() => trigger().click());
  const labels = [...container.querySelectorAll('[role="option"]')].map(
    (o) => o.textContent ?? '',
  );
  act(() => trigger().click());
  return labels;
}

/** Open the menu and click the row with this label. */
function pickModel(label: string): void {
  act(() => trigger().click());
  const row = [
    ...container.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((o) => o.textContent === label);
  if (!row) {
    throw new Error(`no menu row labelled ${label}`);
  }
  act(() => row.click());
}

/** Type into the custom-model input through the prototype setter, so React's
 *  value tracking sees the change (the repo-wide idiom — see Chats.spec.tsx). */
function typeCustom(value: string): void {
  const el = customInput()!;
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el) as object,
    'value',
  )!.set!.call(el, value);
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ModelSelect', () => {
  it('lists only the agent aliases + Custom — no CLI-default entry', () => {
    render(
      <ModelSelect id="m" agent="claude" value="opus" onChange={() => {}} />,
    );
    expect(modelOptions()).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'Custom…',
    ]);

    render(
      <ModelSelect
        id="m"
        agent="cursor-agent"
        value="gpt-5"
        onChange={() => {}}
      />,
    );
    expect(modelOptions()).toEqual([
      'gpt-5',
      'sonnet-4',
      'sonnet-4-thinking',
      'Custom…',
    ]);
  });

  it('a model-less node adopts the first alias on mount', () => {
    render(<Harness />);
    expect(spy).toHaveBeenCalledWith('fable');
    expect(trigger().textContent).toContain('fable');
    expect(customInput()).toBeNull();
  });

  it('picking an alias emits it', () => {
    render(<Harness initial="sonnet" />);
    pickModel('opus');
    expect(spy).toHaveBeenLastCalledWith('opus');
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
    expect(trigger().textContent).toContain('Custom…');
    expect(customInput()?.value).toBe('claude-fable-5');
  });

  it('Custom… opens free-text entry without erasing the stored model', () => {
    render(<Harness initial="opus" />);
    pickModel('Custom…');
    // Switching modes alone must not touch the node — only typing does.
    expect(spy).not.toHaveBeenCalled();
    expect(customInput()?.value).toBe('opus');

    typeCustom('claude-fable-5');
    expect(spy).toHaveBeenLastCalledWith('claude-fable-5');
  });

  it('clearing the custom input keeps custom mode — no snap-back to an alias', () => {
    render(<Harness initial="claude-fable-5" />);
    expect(trigger().textContent).toContain('Custom…');
    typeCustom('');
    // A transiently empty value mid-typing must NOT trigger alias adoption.
    expect(spy).toHaveBeenLastCalledWith(undefined);
    expect(spy).not.toHaveBeenCalledWith('fable');
    expect(trigger().textContent).toContain('Custom…');
    expect(customInput()).not.toBeNull();
  });

  it('leaving custom mode via an alias emits the alias and hides the input', () => {
    render(<Harness initial="my-custom-model" />);
    pickModel('sonnet');
    expect(spy).toHaveBeenLastCalledWith('sonnet');
    expect(customInput()).toBeNull();
  });
});
