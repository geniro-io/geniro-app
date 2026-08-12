// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigDirSelect } from './config-dir-select';

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

const trigger = (el: HTMLElement): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>('[data-menu-trigger]');

/** The menu's rows — the picker is ours, so they are real DOM, not an OS menu. */
function options(el: HTMLElement): HTMLElement[] {
  act(() => {
    trigger(el)!.click();
  });
  return [...el.querySelectorAll<HTMLElement>('[role="option"]')];
}

const RECENTS = ['/Users/me/profiles/work', '/Users/me/profiles/personal'];

describe('ConfigDirSelect', () => {
  it('lists the recents, a clear row and a browse row', () => {
    const el = render(
      <ConfigDirSelect
        configDir={RECENTS[0]!}
        recentConfigDirs={RECENTS}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(options(el).map((o) => o.textContent)).toEqual([
      '…/me/profiles/work',
      '…/me/profiles/personal',
      'Default profile',
      'Choose config directory…',
    ]);
    // The chip is compact where the rows are not: two profiles can
    // share a leaf, so the ROWS carry enough path to tell them apart.
    expect(trigger(el)!.textContent).toContain('work');
  });

  it('renders NOTHING for a CLI that cannot load one — never a disabled chip', () => {
    // The daemon's own sentence, straight off the adapter's config. A disabled
    // chip would state a choice the user does not have (same rule as the
    // effort chip for cursor); re-adding one regresses this.
    const el = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={RECENTS}
        unavailableReason="cursor-agent reads a config directory but keeps the account outside it"
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(trigger(el)).toBeNull();
    expect(el.textContent).toBe('');
  });

  it('renders nothing while the capability answer is still unknown', () => {
    // `undefined` is "the daemon has not said", which must not be read as
    // either verdict — the honest rendering is no chip at all.
    const el = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={[]}
        unavailableReason={undefined}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(trigger(el)).toBeNull();
  });

  it('reports a picked directory, and null from the clear row', () => {
    const onChange = vi.fn();
    const el = render(
      <ConfigDirSelect
        configDir={RECENTS[0]!}
        recentConfigDirs={RECENTS}
        unavailableReason={null}
        onChange={onChange}
        onBrowse={() => {}}
      />,
    );
    const rows = options(el);
    act(() => {
      rows[1]!.click();
    });
    // The FULL path, not the elided label the row displays.
    expect(onChange).toHaveBeenCalledWith(RECENTS[1]);

    const reopened = options(el);
    act(() => {
      reopened[2]!.click();
    });
    // null, never the row's sentinel value: "default profile" must not
    // reach the daemon as a directory named `clear`.
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('opens the native dialog from the browse row instead of choosing a path', () => {
    const onChange = vi.fn();
    const onBrowse = vi.fn();
    const el = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={RECENTS}
        unavailableReason={null}
        onChange={onChange}
        onBrowse={onBrowse}
      />,
    );
    const rows = options(el);
    act(() => {
      rows[rows.length - 1]!.click();
    });
    expect(onBrowse).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows a chosen directory that is not among the recents yet', () => {
    // The very first pick, before it has been persisted into the recents: the
    // menu still has a row to put its checkmark on.
    const el = render(
      <ConfigDirSelect
        configDir="/Users/me/profiles/fresh"
        recentConfigDirs={RECENTS}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(options(el).map((o) => o.textContent)).toContain(
      '…/me/profiles/fresh',
    );
  });
});
