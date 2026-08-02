// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Menu, type MenuGroup } from './menu';

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

const rows = (el: HTMLElement): HTMLElement[] => [
  ...el.querySelectorAll<HTMLElement>('[role="option"]'),
];

const labels = (el: HTMLElement): (string | null)[] =>
  rows(el).map((r) => r.textContent);

const search = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>('input')!;

const type = (el: HTMLElement, text: string): void => {
  const input = search(el);
  act(() => {
    // React tracks the DOM value to dedupe change events; setting it through
    // the native setter is what makes onChange fire in a synthetic environment.
    // The descriptor comes off the element's OWN prototype — the element and
    // the test run in different realms, so the global HTMLInputElement is a
    // different constructor and its setter rejects this instance.
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input) as object,
      'value',
    )!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const hover = (el: HTMLElement, label: string): HTMLElement => {
  const row = rows(el).find((r) => r.textContent === label)!;
  act(() => {
    row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  return row;
};

/** The highlighted row — the one painted with the accent background. */
const highlighted = (el: HTMLElement): (string | null)[] =>
  rows(el)
    .filter((r) => r.classList.contains('bg-accent'))
    .map((r) => r.textContent);

const press = (el: HTMLElement, key: string): void => {
  act(() => {
    el.querySelector('[role="listbox"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true }),
    );
  });
};

const BRANCHES: MenuGroup[] = [
  {
    items: [
      { value: 'main', label: 'main' },
      { value: 'feat/chips', label: 'feat/chips' },
      { value: 'fix/select', label: 'fix/select' },
    ],
  },
];

function open(
  groups: MenuGroup[] = BRANCHES,
  props: Partial<React.ComponentProps<typeof Menu>> = {},
): HTMLDivElement {
  return render(
    <Menu
      open
      groups={groups}
      value="main"
      onSelect={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );
}

describe('Menu', () => {
  it('renders nothing while closed', () => {
    const el = render(
      <Menu
        open={false}
        groups={BRANCHES}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(el.querySelector('[role="listbox"]')).toBeNull();
  });

  it('filters rows by the search query', () => {
    const el = open(BRANCHES, { searchPlaceholder: 'Search branches…' });

    type(el, 'fi');

    expect(labels(el)).toEqual(['fix/select']);
  });

  it('matches the full value behind an abbreviated label', () => {
    // A folder row's label is elided at the front (…/Projects/price-field), so
    // matching the label alone would find nothing for a search on the part
    // that was elided away — which is most of what the user can type.
    const el = open(
      [
        {
          items: [
            {
              value: '/Users/me/Desktop/Projects/price-field',
              label: '…/Desktop/Projects/price-field',
              title: '/Users/me/Desktop/Projects/price-field',
            },
          ],
        },
      ],
      { searchPlaceholder: 'Search folders…' },
    );

    type(el, 'users/me');

    expect(labels(el)).toEqual(['…/Desktop/Projects/price-field']);
  });

  it('keeps an action row visible through a filter that excludes it', () => {
    // "Choose folder…" is how the user escapes a search that matched nothing;
    // filtering it out by label would strand them in an empty menu.
    const el = open(
      [
        { label: 'Recents', items: [{ value: '/a/proj', label: '/a/proj' }] },
        {
          items: [{ value: 'browse', label: 'Choose folder…', action: true }],
        },
      ],
      { searchPlaceholder: 'Search folders…' },
    );

    type(el, 'zzz');

    expect(labels(el)).toEqual(['Choose folder…']);
  });

  it('highlights the row the cursor is over — not a different one', () => {
    // The regression pin for the hover handler's captured index. A counter
    // mutated across the render is a single binding every row's handler shares,
    // so each closure reads its FINAL value: hovering any row would highlight
    // the last one, and hovering the last would look like nothing happening.
    const el = open();

    expect(highlighted(el)).toEqual(['main']);

    hover(el, 'feat/chips');

    expect(highlighted(el)).toEqual(['feat/chips']);
  });

  it('numbers rows continuously across groups when hovering', () => {
    // A group's rows are offset by every row above it. Numbering per group
    // instead would make a hover in the second group highlight a row in the
    // first — and the offset is exactly what the removed counter used to do.
    // The second row of EACH group, so numbering per group would light up both.
    const el = open([
      {
        label: 'Agents',
        items: [
          { value: 'claude', label: 'claude' },
          { value: 'cursor', label: 'cursor' },
        ],
      },
      {
        label: 'Workflows',
        items: [
          { value: 'wf:review', label: 'Review team' },
          { value: 'wf:ship', label: 'Ship team' },
        ],
      },
    ]);

    hover(el, 'Ship team');

    expect(highlighted(el)).toEqual(['Ship team']);
  });

  it('commits the hovered row on Enter', () => {
    // Hover and the arrow keys drive ONE highlight, so a mis-set hover index
    // silently redirects the keyboard commit too.
    const onSelect = vi.fn();
    const el = open(BRANCHES, { onSelect });

    hover(el, 'feat/chips');
    press(el, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('feat/chips');
  });

  it('moves the highlight with the arrow keys and commits with Enter', () => {
    const onSelect = vi.fn();
    const el = open(BRANCHES, { onSelect });

    press(el, 'ArrowDown');
    press(el, 'ArrowDown');
    press(el, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('fix/select');
  });

  it('wraps the highlight around the ends of the list', () => {
    const onSelect = vi.fn();
    const el = open(BRANCHES, { onSelect });

    // From the first row, Up wraps to the last rather than sticking.
    press(el, 'ArrowUp');
    press(el, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('fix/select');
  });

  it('commits a row that survived the filter, not the one at that index before', () => {
    // The highlight indexes into the VISIBLE rows; if filtering did not reset
    // it, Enter after a search would fire whatever row now sat at the old
    // position — picking a branch the user never saw.
    const onSelect = vi.fn();
    const el = open(BRANCHES, {
      onSelect,
      searchPlaceholder: 'Search branches…',
    });

    press(el, 'ArrowDown');
    press(el, 'ArrowDown');
    type(el, 'main');
    press(el, 'Enter');

    expect(onSelect).toHaveBeenCalledWith('main');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    const el = open(BRANCHES, { onClose });

    press(el, 'Escape');

    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a click outside the panel', () => {
    const onClose = vi.fn();
    open(BRANCHES, { onClose });

    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('stays open for a click inside the panel', () => {
    const onClose = vi.fn();
    const el = open(BRANCHES, { onClose });

    act(() => {
      el.querySelector('[role="listbox"]')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      );
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('says so when nothing matches', () => {
    const el = open(BRANCHES, { searchPlaceholder: 'Search branches…' });

    type(el, 'nothing-here');

    expect(rows(el)).toHaveLength(0);
    expect(el.textContent).toContain('No matches');
  });
});
