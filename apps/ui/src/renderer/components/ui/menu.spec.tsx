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

  it('sizes the panel to its longest row, between a floor and a ceiling', () => {
    // The panel used to take its shrink-to-fit width and land exactly on
    // `min-w-56` whatever its rows said, so every label truncated inside a
    // panel with room to spare — measured in the running app as the composer's
    // model-settings panel at 210px with `Approval` clipped to `Appro…`, and
    // 216px with nothing clipped once the panel asks for its content.
    //
    // A CLASS assertion deliberately: jsdom computes no layout, so the width
    // itself is unobservable here — but WHICH sizing the panel declares is the
    // DOM fact that decides it, and it is the half that regressed.
    const el = open();
    const panel = el.querySelector('[data-slot="menu-panel"]')!;

    expect(panel.className).toContain('w-max');
    // The bounds stay: never narrower than the floor, never past the cap, and
    // a row longer than the cap still truncates the way it always did.
    expect(panel.className).toContain('min-w-56');
    expect(panel.className).toContain('max-w-96');
  });

  it('takes focus on open and draws NO ring around itself for it', () => {
    // REPORTED as a border to drop on the `+` menu, over a dark-theme
    // screenshot where a caramel outline traced the whole panel — measured in
    // the running app as `outline-color: --ring/50`, the base layer's
    // `outline-ring/50` applied because this panel is FOCUSED on every open so
    // the arrow keys have a listener. So it was a focus ring, drawn for a user
    // who had opened the menu by hovering.
    //
    // Both halves are asserted because either one alone is a false pin: the
    // focus is what SUMMONS the ring, so a spec that only read the class would
    // go on passing if the focus moved elsewhere and the class became
    // decoration. A CLASS assertion for the second half deliberately — jsdom
    // computes no layout and resolves no cascade, so the drawn outline is
    // unobservable here, and the declaration is the whole of the fix.
    const el = open();
    const panel = el.querySelector<HTMLElement>('[data-slot="menu-panel"]')!;

    expect(document.activeElement).toBe(panel);
    expect(panel.className).toContain('outline-none');
    // And the keyboard is not left without an indicator, which is the only
    // reason the ring could be dropped rather than retinted: the highlight sits
    // on row 0 from the moment the panel opens.
    expect(rows(el)[0]!.className).toContain('bg-accent');
  });

  it('lets a caller in a narrow container pin the width instead', () => {
    // The chat sidebar's own override — measured at 260px, a menu sized by its
    // longest row came out 257px inside a 235px slot and was clipped by the
    // list's scroll container. That caller passes `w-52`, and it has to WIN
    // over the sizing above or the fix for one surface breaks the other.
    const el = open(BRANCHES, { className: 'min-w-0 w-52' });
    const panel = el.querySelector('[data-slot="menu-panel"]')!;

    expect(panel.className).toContain('w-52');
    expect(panel.className).not.toContain('w-max');
  });

  it('draws no block for a group with no rows, so the group after it carries no stray hairline', () => {
    // A caller composes groups from data, so an empty block is ordinary — the
    // context-window chip's sizes group is empty on a model that offers one
    // fixed window. Rendered, it was a blank band with the next group's
    // separator beneath it, which is what "it didnt load contexts for cursor"
    // was actually looking at. The search path already dropped empty groups;
    // the unfiltered path did not.
    const el = open([
      { items: [] },
      { items: [{ value: 'default', label: 'model default' }] },
    ]);

    expect(el.querySelectorAll('[data-slot="menu-group"]')).toHaveLength(1);
    expect(
      el.querySelector('[data-slot="menu-group"]')!.className,
    ).not.toContain('border-t');
    expect(labels(el)).toEqual(['model default']);
  });

  it('renders a group NOTE as prose beneath its rows’ block, distinct from a heading', () => {
    const el = open([
      {
        label: 'Sizes',
        note: 'kimi-k3 runs at one fixed context window.',
        items: [{ value: 'default', label: 'model default' }],
      },
    ]);

    const note = el.querySelector('[data-slot="menu-group-note"]')!;
    expect(note.textContent).toBe('kimi-k3 runs at one fixed context window.');
    // Not folded into the heading: the heading is an 11px uppercase
    // micro-label, and a sentence set that way outweighs every row under it.
    expect(
      el.querySelector('[data-slot="menu-group-heading"]')!.textContent,
    ).toBe('Sizes');
    expect(note.className).not.toContain('uppercase');
  });

  it('renders a group heading at full token contrast, no opacity modifier', () => {
    // Regression pin: an opacity modifier on this token (`/75`) would lower
    // the heading's contrast against the popover background — jsdom computes
    // no layout, so this cannot measure the resulting ratio, only that the
    // class list carries the bare token and never a suffixed variant.
    const el = open([
      { label: 'Agents', items: [{ value: 'claude', label: 'claude' }] },
    ]);

    const heading = el.querySelector('[data-slot="menu-group-heading"]')!;
    expect(heading.textContent).toBe('Agents');
    // Exact-token match on the split class list — `toContain` on the whole
    // string would also match a suffixed variant like
    // `text-muted-foreground/75`, which is exactly what this pins the absence
    // of.
    const classes = heading.className.split(/\s+/);
    expect(classes).toContain('text-muted-foreground');
    expect(classes.some((c) => c.startsWith('text-muted-foreground/'))).toBe(
      false,
    );
  });
});

describe('Menu — the second level', () => {
  const AXES: MenuGroup[] = [
    {
      items: [
        {
          value: 'axis:effort',
          label: 'Effort',
          hint: 'high',
          submenu: [
            {
              items: [
                { value: 'effort:low', label: 'low' },
                { value: 'effort:high', label: 'high' },
              ],
            },
          ],
        },
        { value: 'plain', label: 'Plain row' },
      ],
    },
  ];

  /** The parent's rows container, and the child's. */
  const listboxes = (el: HTMLElement): HTMLElement[] => [
    ...el.querySelectorAll<HTMLElement>('[role="listbox"]'),
  ];

  const axisRow = (el: HTMLElement): HTMLElement =>
    rows(el).find((r) => r.querySelector('span')?.textContent === 'Effort')!;

  function openAxis(el: HTMLElement): void {
    act(() => {
      axisRow(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  /** Press a key IN the second level, where the user's focus actually is. */
  function pressInSubmenu(el: HTMLElement, key: string): void {
    act(() => {
      listboxes(el)[1]!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    });
  }

  it('advertises the panel behind an axis row instead of marking it chosen', () => {
    // A row that OPENS a level is a heading with a value on it, not a choice —
    // so it must not claim `aria-selected`, and it must say what it controls.
    const el = open(AXES);
    const row = axisRow(el);

    expect(row.getAttribute('aria-haspopup')).toBe('listbox');
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(row.hasAttribute('aria-selected')).toBe(false);
    // …and a plain row keeps it, so this is a distinction rather than a
    // blanket removal.
    expect(
      rows(el)
        .find((r) => r.querySelector('span')?.textContent === 'Plain row')
        ?.hasAttribute('aria-selected'),
    ).toBe(true);

    openAxis(el);
    expect(axisRow(el).getAttribute('aria-expanded')).toBe('true');
    const controls = axisRow(el).getAttribute('aria-controls');
    expect(controls).not.toBeNull();
    // By id rather than a selector: `useId` mints `:r0:`-shaped ids, which need
    // escaping in a selector and none in `getElementById`.
    expect(document.getElementById(controls!)).toBe(
      listboxes(el)[1]!.closest('[data-slot="menu-panel"]'),
    );
  });

  it('keeps the second level OUT of the first one’s listbox, and inside its panel', () => {
    // Two rules at once, and they pull in opposite directions: a `listbox` may
    // own only `option`/`group` children, so a nested one makes a screen reader
    // compute the wrong set size for the outer list — while the outside-click
    // guard asks `panel.contains(target)`, so a click two levels down must
    // still be a descendant or choosing a value would close the menu under
    // itself.
    const el = open(AXES);
    openAxis(el);

    const [parentList, childList] = listboxes(el);
    expect(childList).toBeDefined();
    expect(parentList!.contains(childList!)).toBe(false);

    const parentPanel = el.querySelector<HTMLElement>(
      '[data-slot="menu-panel"]',
    )!;
    expect(parentPanel.contains(childList!)).toBe(true);
  });

  it('does not drive the FIRST level with a key pressed in the second', () => {
    // The child is rendered inside the parent's DOM, so without
    // `stopPropagation` every arrow press moved BOTH highlights and the parent
    // painted its accent on a row that was not the one whose submenu is open.
    const el = open(AXES);
    openAxis(el);
    const before = highlighted(listboxes(el)[0]!);

    pressInSubmenu(el, 'ArrowDown');

    expect(highlighted(listboxes(el)[0]!)).toEqual(before);
    // …and the press DID reach the level it was pressed in.
    expect(highlighted(listboxes(el)[1]!)).toEqual(['high']);
  });

  it('commits exactly once when Enter is pressed in the second level', () => {
    // The wrong-value double commit the propagation above would cause: the
    // parent's own Enter handler would commit whatever ITS highlight had
    // reached, alongside the value the user actually chose.
    const onSelect = vi.fn();
    const el = open(AXES, { onSelect });
    openAxis(el);

    pressInSubmenu(el, 'ArrowDown');
    pressInSubmenu(el, 'Enter');

    expect(onSelect.mock.calls).toEqual([['effort:high']]);
  });

  it('lets a key it does NOT handle reach the ancestors', () => {
    // `Menu` backs every picker in the app and renders inside whatever opened
    // it. `Dialog` traps Tab on its card and closes on Escape from a `document`
    // listener; `App` binds ⌥⌘L on `window`. React's stopPropagation stops the
    // NATIVE event at its root container, below all three — so stopping every
    // key let Tab escape the modal focus trap for as long as a picker was open.
    const el = open(AXES);
    openAxis(el);
    const seen: string[] = [];
    const onWindowKey = (event: KeyboardEvent): void => {
      seen.push(event.key);
    };
    window.addEventListener('keydown', onWindowKey);
    try {
      pressInSubmenu(el, 'Tab');
      pressInSubmenu(el, 'l');
      // …and the ones it DOES consume are still stopped, or the second level
      // would go back to driving the first.
      pressInSubmenu(el, 'ArrowDown');
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }

    expect(seen).toEqual(['Tab', 'l']);
  });

  it('ArrowLeft in the SEARCH field moves the caret rather than closing the level', () => {
    // The model list is the one submenu with a search field, and it is focused
    // the moment the level opens — so backing out on ArrowLeft would discard a
    // half-typed query over the very list the field exists for.
    const el = open([
      {
        items: [
          {
            value: 'axis:model',
            label: 'Model',
            submenuSearchPlaceholder: 'Search models…',
            submenu: [{ items: [{ value: 'model:opus', label: 'opus' }] }],
          },
        ],
      },
    ]);
    act(() => {
      rows(el)[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const field = [...el.querySelectorAll('input')].at(-1)!;
    expect(field.getAttribute('placeholder')).toBe('Search models…');

    act(() => {
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
    });

    // Still open: two panels, the child among them.
    expect(el.querySelectorAll('[role="listbox"]')).toHaveLength(2);
  });

  it('ArrowLeft backs out of the second level, keeping the first open', () => {
    // Before this the only way out was Escape, which closes the whole picker —
    // so a keyboard user who opened the wrong axis had to reopen the panel and
    // navigate back to where they were.
    const onClose = vi.fn();
    const el = open(AXES, { onClose });
    openAxis(el);
    expect(listboxes(el)).toHaveLength(2);

    pressInSubmenu(el, 'ArrowLeft');

    expect(listboxes(el)).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(axisRow(el).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Menu — a row that carries a colour', () => {
  const row = (el: HTMLElement, label: string): HTMLElement =>
    [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
      node.textContent?.includes(label),
    )!;

  it('draws the colour as a LEFT BORDER, from the palette', () => {
    // Asked for in those words — "там должен быть просто левый бордер вот этого
    // же цвета". A border rather than a second glyph: the row already leads
    // with an icon saying what KIND of thing it is, and an edge stripe is read
    // by position while costing the label no width. It is also how the sidebar
    // already draws a group's colour, so a named agent configuration and a chat
    // group wear theirs the same way.
    //
    // Asserted on the class, because jsdom loads no stylesheet — and on the
    // PALETTE's class specifically, since a raw colour here is an eslint error.
    const el = render(
      <Menu
        open
        groups={[
          {
            items: [
              { value: 'a', label: 'work', accent: 'teal' as const },
              { value: 'b', label: 'plain' },
            ],
          },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(row(el, 'work').className).toContain('border-l-group-teal');
    expect(row(el, 'work').className).toContain('border-l-2');
  });

  it('leaves an uncoloured row exactly as it was', () => {
    // Most rows in most menus have no colour. A transparent placeholder border
    // would shift every label by its width for the sake of the few that do.
    const el = render(
      <Menu
        open
        groups={[
          {
            items: [
              { value: 'a', label: 'work', accent: 'teal' as const },
              { value: 'b', label: 'plain' },
            ],
          },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(row(el, 'plain').className).not.toContain('border-l-2');
    expect(row(el, 'plain').className).not.toMatch(/border-l-group-/);
  });

  it('pulls the left padding back by the border, so labels stay on one line', () => {
    // Otherwise a coloured row's label sits 2px right of its uncoloured
    // neighbours', which on a list where only some directories are named reads
    // as two indents rather than as one list.
    const el = render(
      <Menu
        open
        groups={[
          {
            items: [
              { value: 'a', label: 'work', accent: 'blue' as const },
              { value: 'b', label: 'plain' },
            ],
          },
        ]}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    // `px-2.5` is 10px; the coloured row takes 8px plus a 2px border.
    expect(row(el, 'work').className).toContain('pl-2');
    expect(row(el, 'work').className).not.toMatch(/(^| )pl-2\.5( |$)/);
    expect(row(el, 'plain').className).toContain('px-2.5');
  });
});

describe('Menu — fitting the window', () => {
  /**
   * Open with the panel reporting a given rect.
   *
   * jsdom lays nothing out, so every `getBoundingClientRect` is zeroes and the
   * measurement under test can never fire on its own. The stub is scoped to the
   * PANEL and removed once the layout effect has run.
   */
  function openWithPanelRect(
    rect: { top: number; bottom: number; height: number },
    props: Partial<React.ComponentProps<typeof Menu>> = {},
  ): HTMLDivElement {
    const zero = {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        if (this.getAttribute('data-slot') !== 'menu-panel') {
          return zero;
        }
        return {
          ...zero,
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          // Comfortably inside the window, so the horizontal flip this shares
          // an effect with stays out of the way.
          left: 0,
          right: 200,
          width: 200,
        } as DOMRect;
      });
    try {
      return open(BRANCHES, props);
    } finally {
      spy.mockRestore();
    }
  }

  const panel = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('[data-slot="menu-panel"]')!;

  it('shortens a panel that runs off the TOP of the window', () => {
    // The reported branch picker, as measured at 900×420 before the fix: a
    // 341px panel at `top: -326`, so 326 of its pixels were above the window
    // and fifteen of fourteen branches were unreachable. `max-h-80` caps the
    // ROW LIST; nothing measured whether the panel fitted anywhere.
    const el = openWithPanelRect({ top: -326, bottom: 15, height: 341 });

    // Floored at 120: 341 - 326 - 8 would be 7px, which is not a menu.
    expect(panel(el).style.maxHeight).toBe('120px');
  });

  it('shortens a panel that runs off the BOTTOM, by exactly the overflow', () => {
    // The same measurement on the other edge — a menu opened downward from a
    // trigger near the foot of the window.
    const el = openWithPanelRect(
      { top: 668, bottom: window.innerHeight + 100, height: 341 },
      { side: 'bottom' },
    );

    // 341 - 100 overflow - 8 margin.
    expect(panel(el).style.maxHeight).toBe('233px');
  });

  it('leaves a panel that FITS at its natural height', () => {
    // The common case, and the one a blanket cap would quietly shrink: no
    // inline height at all, so the panel keeps `max-h-80` and its own sizing.
    const el = openWithPanelRect({ top: 24, bottom: 365, height: 341 });

    expect(panel(el).style.maxHeight).toBe('');
  });

  it('drops the cap when the menu closes, so the next open re-measures', () => {
    // The cap belongs to one open at one size. Carried across, a menu once
    // shortened in a small window would stay short in a large one.
    const el = openWithPanelRect({ top: -326, bottom: 15, height: 341 });
    expect(panel(el).style.maxHeight).toBe('120px');

    act(() => {
      root!.render(
        <Menu
          open={false}
          groups={BRANCHES}
          value="main"
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });
    act(() => {
      root!.render(
        <Menu
          open
          groups={BRANCHES}
          value="main"
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );
    });

    // Re-opened with jsdom's zeroed rects — nothing overflows, so no cap.
    expect(panel(el).style.maxHeight).toBe('');
  });
});

describe('Menu — escaping a clipping container', () => {
  const panel = (el: HTMLElement): HTMLElement =>
    el.querySelector<HTMLElement>('[data-slot="menu-panel"]')!;

  /** A trigger whose measured box is not the origin, so placement is readable. */
  function triggerAt(rect: Partial<DOMRect>): {
    ref: React.RefObject<HTMLElement | null>;
    el: HTMLButtonElement;
  } {
    const el = document.createElement('button');
    el.getBoundingClientRect = () =>
      ({ top: 0, bottom: 0, left: 0, right: 0, ...rect }) as DOMRect;
    return { ref: { current: el }, el };
  }

  it('positions from the VIEWPORT when asked, not from its ancestor', () => {
    // The whole point of the mode: an absolute panel is cut by any ancestor
    // that scrolls, and `overflow-x: visible` cannot be restored on a box that
    // scrolls vertically. Only a fixed panel leaves the clip.
    const { ref } = triggerAt({ top: 300, bottom: 340, left: 120, right: 260 });
    const el = render(
      <Menu
        open
        anchor="viewport"
        triggerRef={ref}
        side="bottom"
        groups={BRANCHES}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(panel(el).style.position).toBe('fixed');
    // Below the trigger's bottom edge, measured — not `top-full`, which is an
    // offset inside the clipping ancestor.
    expect(panel(el).style.top).toBe('346px');
    expect(panel(el).style.left).toBe('120px');
    expect(panel(el).className).not.toContain('top-full');
  });

  it('pulls a floating panel back inside the window AFTER it has been placed', () => {
    // The placement takes two commits — one effect measures the trigger and
    // sets the offset, and only the render after that moves the panel — so a
    // correction that measured in the first commit was reading the panel where
    // it had not been placed yet. Reported as "окошко заходит за края
    // аппликэйшена, оно срезается": the landing card's branch picker, newly
    // anchored to the viewport, sat at `right: 1036` in a 1000px window.
    //
    // The stub tracks the panel's OWN offset rather than returning a fixed
    // rect, which is the whole point: a static rect overflows in both commits
    // and would pass with the defect in place.
    const { ref } = triggerAt({ top: 300, bottom: 340, left: 700, right: 840 });
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        if (this.getAttribute('data-slot') !== 'menu-panel') {
          return { top: 0, bottom: 0, left: 0, right: 0 } as DOMRect;
        }
        const left = Number.parseFloat((this as HTMLElement).style.left || '0');
        return {
          top: 346,
          bottom: 646,
          height: 300,
          left,
          right: left + 400,
          width: 400,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const el = render(
        <Menu
          open
          anchor="viewport"
          triggerRef={ref}
          side="bottom"
          groups={BRANCHES}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );

      // 700 + 400 runs 76px past a 1024px window, so it comes back by that
      // much plus the margin — and stops there rather than oscillating.
      expect(panel(el).style.left).toBe(
        `${700 - (1100 - window.innerWidth) - 8}px`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('does not cap a floating panel from the commit BEFORE it is placed', () => {
    // The root cause of the reported "popover is cut", and it is upstream of
    // the placement itself. A floating panel is positioned in TWO commits — one
    // effect reads the trigger and sets the offset, and only the render after
    // that moves the panel — so in the first commit it is still sitting where
    // the ancestor classes put it. The horizontal correction survives that (it
    // re-runs and settles); the HEIGHT clamp does not, because nothing lowers
    // `maxHeight` again until the menu closes. A cap taken at the wrong
    // position was therefore frozen for the life of the open.
    //
    // Measured in the running app on the composer's Profile submenu: an
    // eight-row panel came out `maxHeight: 120px` — the FLOOR — while sitting
    // at `top: 715` in a 900px window, with over 170px of room and no need for
    // a cap at all.
    //
    // The stub reports an OVERFLOWING rect until the panel has been placed,
    // which is what the real first commit does; a static rect would overflow in
    // both commits and could not tell the two apart.
    const { ref } = triggerAt({ top: 100, bottom: 140, left: 120, right: 260 });
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        if (this.getAttribute('data-slot') !== 'menu-panel') {
          return { top: 0, bottom: 0, left: 0, right: 0 } as DOMRect;
        }
        const placed = (this as HTMLElement).style.top !== '';
        const top = placed
          ? Number.parseFloat((this as HTMLElement).style.top)
          : 700;
        return {
          top,
          bottom: top + 200,
          height: 200,
          left: 0,
          right: 200,
          width: 200,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const el = render(
        <Menu
          open
          anchor="viewport"
          triggerRef={ref}
          side="bottom"
          groups={BRANCHES}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );

      // Placed under a trigger ending at 140, a 200px panel ends at 346 —
      // comfortably inside a 768px window. The unplaced first commit's 700+200
      // must not have left a cap behind.
      expect(panel(el).style.maxHeight).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('MOVES a submenu up when it would run off the bottom, rather than shortening it', () => {
    // REPORTED as "popover is cut", against the composer's Profile submenu:
    // `side='right'` pins the panel's top to the row that opened it and grows
    // DOWN, and that parent menu opens upward from a control at the foot of the
    // window — so a row low on screen put the submenu's tail off the bottom.
    //
    // The height clamp is not the answer here. It is FLOORED at
    // `MIN_MENU_HEIGHT` on purpose, so once the room under the row falls below
    // that floor the panel overhangs anyway, and the rows past the edge are
    // unreachable: what scrolls is the list inside a panel whose own box is off
    // the screen. Moving it is what every other placement already does in some
    // form, and a shifted submenu still sits beside its row — which is all this
    // placement ever promised.
    //
    // The stub tracks the panel's OWN top rather than returning a fixed rect,
    // for the reason the horizontal test above states: a static rect overflows
    // in both commits and would pass with the defect in place.
    const { ref } = triggerAt({ top: 900, bottom: 940, left: 120, right: 260 });
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        if (this.getAttribute('data-slot') !== 'menu-panel') {
          return { top: 0, bottom: 0, left: 0, right: 0 } as DOMRect;
        }
        const top = Number.parseFloat((this as HTMLElement).style.top || '0');
        return {
          top,
          bottom: top + 300,
          height: 300,
          left: 0,
          right: 200,
          width: 200,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const el = render(
        <Menu
          open
          anchor="viewport"
          triggerRef={ref}
          side="right"
          groups={BRANCHES}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );

      // Placed at the row's top less the 5px nudge (895), a 300px panel ends at
      // 1195 — 435px past a 768px window's safe edge. It comes back by exactly
      // that, and STAYS the full height rather than being cut to the floor.
      const expected = 895 - (1195 - (window.innerHeight - 8));
      expect(panel(el).style.top).toBe(`${expected}px`);
      expect(panel(el).style.maxHeight).toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('still SHORTENS a submenu taller than the window, once it can move no further', () => {
    // Moving is the first answer, not the only one. A panel that overhangs even
    // with its top against the margin has nowhere left to go, and the clamp
    // below is what catches it — which is the genuinely taller-than-the-window
    // case, and only that.
    const { ref } = triggerAt({ top: 20, bottom: 60, left: 120, right: 260 });
    const spy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: Element): DOMRect {
        if (this.getAttribute('data-slot') !== 'menu-panel') {
          return { top: 0, bottom: 0, left: 0, right: 0 } as DOMRect;
        }
        const top = Number.parseFloat((this as HTMLElement).style.top || '0');
        const height = window.innerHeight + 200;
        return {
          top,
          bottom: top + height,
          height,
          left: 0,
          right: 200,
          width: 200,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      const el = render(
        <Menu
          open
          anchor="viewport"
          triggerRef={ref}
          side="right"
          groups={BRANCHES}
          onSelect={() => {}}
          onClose={() => {}}
        />,
      );

      // Against the top margin, and shortened from there.
      expect(panel(el).style.top).toBe('8px');
      expect(panel(el).style.maxHeight).not.toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('opens UPWARD from the trigger when the side says so', () => {
    const { ref } = triggerAt({ top: 300, bottom: 340, left: 120, right: 260 });
    const el = render(
      <Menu
        open
        anchor="viewport"
        triggerRef={ref}
        side="top"
        groups={BRANCHES}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    // Pinned to the window's bottom minus the trigger's top — the panel grows
    // up from there, which is what a branch chip low in a dialog needs.
    expect(panel(el).style.bottom).toBe(`${window.innerHeight - 300 + 6}px`);
    expect(panel(el).style.top).toBe('');
  });

  it('falls back to the ancestor placement when it has nothing to measure', () => {
    // A viewport anchor with no trigger ref cannot be honoured; rendering at
    // the window's origin would be worse than the placement it replaced.
    const el = render(
      <Menu
        open
        anchor="viewport"
        side="bottom"
        groups={BRANCHES}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );

    expect(panel(el).style.position).toBe('');
    expect(panel(el).className).toContain('top-full');
  });
});
