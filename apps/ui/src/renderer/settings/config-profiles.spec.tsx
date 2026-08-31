// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigProfile } from '../../shared/contracts';
import { ConfigProfileList, defaultName } from './config-profiles';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

const profile = (over: Partial<ConfigProfile> = {}): ConfigProfile => ({
  id: 'p1',
  name: 'Work',
  dir: '/Users/x/.claude-work',
  color: 'blue',
  ...over,
});

function render(
  profiles: ConfigProfile[],
  pick: () => Promise<string | null> = async () => null,
): { el: HTMLElement; changes: ConfigProfile[][] } {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const changes: ConfigProfile[][] = [];
  act(() => {
    root.render(
      <ConfigProfileList
        profiles={profiles}
        onChange={(next) => changes.push(next)}
        onPickDirectory={pick}
      />,
    );
  });
  return { el: container, changes };
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

/**
 * Type into a controlled field the way React's own onChange sees it.
 *
 * React tracks an input's value on the node, so assigning `.value` directly and
 * firing `input` is swallowed — the handler never runs and the assertion passes
 * against a component that did nothing. The native setter is what defeats the
 * tracker; the same helper is in `fast-actions.spec.tsx` for the same reason.
 */
function type(el: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The one control whose label starts with `text` — rows are keyed by name. */
function byLabel(el: HTMLElement, text: string): HTMLElement {
  const found = [...el.querySelectorAll<HTMLElement>('[aria-label]')].find(
    (node) => node.getAttribute('aria-label')?.startsWith(text),
  );
  expect(found, `no control labelled ${text}`).toBeDefined();
  return found!;
}

describe('ConfigProfileList', () => {
  it('says what the feature is FOR when there is nothing in it', () => {
    // Empty is the state most installs are in and will stay in, so the empty
    // case has to explain rather than report a count of zero.
    const { el } = render([]);
    expect(el.textContent).toContain('None yet');
    expect(el.querySelector('[data-slot="config-profile-row"]')).toBeNull();
  });

  it('draws a row per configuration — swatch, name and directory', () => {
    const { el } = render([
      profile(),
      profile({ id: 'p2', name: 'Personal', dir: '/Users/x/.claude-home' }),
    ]);
    const rows = el.querySelectorAll('[data-slot="config-profile-row"]');
    expect(rows).toHaveLength(2);
    expect(el.textContent).toContain('.claude-work');
    // The NAME is an input, so it is not in `textContent` — read the value.
    expect(
      (byLabel(el, 'Name for /Users/x/.claude-work') as HTMLInputElement).value,
    ).toBe('Work');
  });

  it('gives the colour cell a FIXED width, so the columns after it line up', () => {
    // REPORTED as the list not being straight. The colour trigger was the one
    // content-sized cell in the row and also the FIRST, so `Blue` and `Orange`
    // started their neighbours at different x and every column after them was
    // ragged — the delete buttons agreed only because they are pushed against
    // the right edge. jsdom computes no layout, so the emitted class is the
    // observable; it is also the whole mechanism, since the row's other three
    // cells were already fixed (`w-40`), flexible (`flex-1`) or `shrink-0`.
    const { el } = render([
      profile({ color: 'blue' }),
      profile({ id: 'p2', name: 'Personal', color: 'orange' }),
    ]);
    const triggers = [
      ...el.querySelectorAll<HTMLElement>('[data-menu-trigger]'),
    ];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.className).toContain('w-28');
      expect(trigger.className).toContain('shrink-0');
    }
  });

  it('elides a directory from the HEAD, keeping the end that identifies it', () => {
    // Two segments rather than the default three: this cell is last in a row
    // that has already spent its width on a colour, a name field and a delete
    // button, and at three the path overran and was CSS-truncated — which eats
    // the TAIL, the one end that says which directory it is. Measured in the
    // running app after the change: both rows fit with nothing cut.
    const { el } = render([
      profile({ dir: '/Users/x/Desktop/Projects/workspace/.claude-work' }),
    ]);
    expect(el.textContent).toContain('…/workspace/.claude-work');
    expect(el.textContent).not.toContain('Desktop');
  });

  it('takes the colour from the PALETTE, never an inline value', () => {
    // `renderer-design-system.md` makes a raw colour an eslint error, and the
    // eight `--color-group-*` tokens are the app's one palette — the same ones
    // the sidebar's groups use, so a blue profile and a blue group are the same
    // blue. Asserted on the class because jsdom loads no stylesheet.
    const { el } = render([profile({ color: 'teal' })]);
    const dot = el.querySelector<HTMLElement>('[data-color="teal"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-group-teal');
  });

  it('commits a rename on BLUR, not on every keystroke', async () => {
    const { el, changes } = render([profile()]);
    const input = byLabel(
      el,
      'Name for /Users/x/.claude-work',
    ) as HTMLInputElement;

    type(input, 'Client');
    // Nothing written yet: a per-keystroke commit rewrites settings.json once
    // per letter.
    expect(changes).toHaveLength(0);

    await act(async () => {
      // `focusout`, not `blur`: React maps `onBlur` onto the bubbling
      // `focusout` event, and a `blur` dispatched here reaches no handler at
      // all — the test would then pass for a component that never committed.
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]![0]!.name).toBe('Client');
  });

  it('treats an emptied name as a REVERT rather than a save', async () => {
    // The schema refuses `min(1)`, so writing it would fail the whole patch and
    // take the rest of the list down with it.
    const { el, changes } = render([profile()]);
    const input = byLabel(
      el,
      'Name for /Users/x/.claude-work',
    ) as HTMLInputElement;

    type(input, '   ');
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(changes).toHaveLength(0);
    expect(input.value).toBe('Work');
  });

  it('adds the directory the picker returns, named after its own leaf', async () => {
    const { el, changes } = render([], async () => '/Users/x/.claude-lab');

    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(1);
    expect(changes[0]![0]!.dir).toBe('/Users/x/.claude-lab');
    expect(changes[0]![0]!.name).toBe('claude-lab');
  });

  it('refuses a SECOND entry for a directory already in the list', async () => {
    // The directory is the identity: two names for one account leaves nothing
    // able to say which of them a run is using.
    const { el, changes } = render(
      [profile()],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(changes).toHaveLength(0);
  });

  it('refuses to RE-POINT a row at a directory another row already stands for', async () => {
    // The same invariant as the test above, on the other path that can set a
    // directory. Enforced on the add alone, the row's own directory button was
    // free to aim at a folder already in the list — two names for one account,
    // reached by the control that exists to change one.
    const { el, changes } = render(
      [profile(), profile({ id: 'p2', name: 'Lab', dir: '/Users/x/.lab' })],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      byLabel(el, 'Change the directory for Lab').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes).toHaveLength(0);
  });

  it('lets a row be re-picked onto the directory it is already on', async () => {
    // The guard is about OTHER rows: a row that refused itself would make
    // re-confirming the same folder look like a broken button.
    const { el, changes } = render(
      [profile()],
      async () => '/Users/x/.claude-work',
    );

    await act(async () => {
      byLabel(el, 'Change the directory for Work').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]![0]!.dir).toBe('/Users/x/.claude-work');
  });

  it('writes nothing when the picker is cancelled', async () => {
    const { el, changes } = render([]);
    await act(async () => {
      [...el.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Add configuration'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(changes).toHaveLength(0);
  });

  it('removes one entry and leaves the rest in the user’s order', async () => {
    const { el, changes } = render([
      profile(),
      profile({ id: 'p2', name: 'Personal', dir: '/Users/x/.claude-home' }),
      profile({ id: 'p3', name: 'Lab', dir: '/Users/x/.claude-lab' }),
    ]);

    await act(async () => {
      byLabel(el, 'Remove Personal').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });

    expect(changes[0]!.map((row) => row.id)).toEqual(['p1', 'p3']);
  });
});

describe('defaultName', () => {
  it('drops a leading dot — a hidden folder is not called `.claude-work`', () => {
    expect(defaultName('/Users/x/.claude-work')).toBe('claude-work');
  });

  it('ignores a trailing separator', () => {
    expect(defaultName('/Users/x/profiles/team/')).toBe('team');
  });

  it('never returns the empty string the schema would refuse', () => {
    // `min(1)` on the name, so a path with no usable segment has to fall back
    // to a word rather than to a value the very next write would reject.
    expect(defaultName('/')).toBe('Configuration');
    expect(defaultName('')).toBe('Configuration');
  });
});
