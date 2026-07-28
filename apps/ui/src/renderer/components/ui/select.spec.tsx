// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Select } from './select';

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

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const trigger = (el: HTMLElement): HTMLButtonElement =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]')!;

const open = (el: HTMLElement): void => {
  act(() => {
    trigger(el).click();
  });
};

const options = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[role="option"]'),
];

const AGENTS = [
  {
    label: 'Agents',
    items: [
      { value: 'claude', label: 'claude' },
      { value: 'cursor-agent', label: 'cursor-agent' },
    ],
  },
  {
    label: 'Workflows',
    items: [{ value: 'wf:review', label: 'Review team' }],
  },
];

describe('Select', () => {
  it('shows the selected option label on the trigger', () => {
    const el = render(
      <Select
        variant="ghost"
        groups={AGENTS}
        value="wf:review"
        onValueChange={() => {}}
      />,
    );

    expect(trigger(el).textContent).toContain('Review team');
  });

  it('falls back to the placeholder when the value matches no option', () => {
    // A legacy run stored an approval mode the current menu no longer offers;
    // the trigger must not go blank and must not invent a label.
    const el = render(
      <Select
        groups={AGENTS}
        value={null}
        placeholder="cli default"
        onValueChange={() => {}}
      />,
    );

    expect(trigger(el).textContent).toContain('cli default');
  });

  it('lets the trigger show a shorter label than the menu row', () => {
    // The folder picker lists full paths (two checkouts of one repo share a
    // leaf name) but the chip has room for the leaf only.
    const el = render(
      <Select
        variant="ghost"
        groups={[{ items: [{ value: '/a/b/proj', label: '/a/b/proj' }] }]}
        value="/a/b/proj"
        triggerLabel="proj"
        onValueChange={() => {}}
      />,
    );

    expect(trigger(el).textContent).toContain('proj');
    expect(trigger(el).textContent).not.toContain('/a/b');
  });

  it('keeps the menu closed until the trigger is pressed', () => {
    const el = render(
      <Select groups={AGENTS} value="claude" onValueChange={() => {}} />,
    );

    expect(options(el)).toHaveLength(0);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('false');

    open(el);

    expect(options(el).map((o) => o.textContent)).toEqual([
      'claude',
      'cursor-agent',
      'Review team',
    ]);
    expect(trigger(el).getAttribute('aria-expanded')).toBe('true');
  });

  it('reports the picked value and closes', () => {
    const onValueChange = vi.fn();
    const el = render(
      <Select groups={AGENTS} value="claude" onValueChange={onValueChange} />,
    );
    open(el);

    act(() => {
      options(el)[2]!.click();
    });

    expect(onValueChange).toHaveBeenCalledWith('wf:review');
    expect(options(el)).toHaveLength(0);
  });

  it('marks only the current value as selected', () => {
    const el = render(
      <Select groups={AGENTS} value="cursor-agent" onValueChange={() => {}} />,
    );
    open(el);

    expect(options(el).map((o) => o.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
  });

  it('never marks an action row as the current value', () => {
    // "Choose folder…" is a command, not a choice — a checkmark on it would
    // claim the user had picked the browse row as their folder.
    const el = render(
      <Select
        groups={[
          {
            items: [{ value: 'browse', label: 'Choose folder…', action: true }],
          },
        ]}
        value="browse"
        onValueChange={() => {}}
      />,
    );
    open(el);

    expect(options(el)[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('does not open while disabled', () => {
    // The approval chip locks mid-turn (the daemon 409s a flip); a menu that
    // still opened would offer a choice that cannot be committed.
    const el = render(
      <Select
        groups={AGENTS}
        value="claude"
        disabled
        onValueChange={() => {}}
      />,
    );

    open(el);

    expect(options(el)).toHaveLength(0);
  });
});
