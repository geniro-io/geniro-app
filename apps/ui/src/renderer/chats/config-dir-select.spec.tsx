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

  it('lists a NAMED profile even when it has never been picked', () => {
    // The reported bug, in one assertion. Rows came from `recentConfigDirs`
    // alone — an MRU that only grows when a directory is chosen THROUGH this
    // menu — so a profile named in Settings had no row here at all, and the
    // colour the palette was wiring up hung off a row that could not exist.
    // "I've added a configuration but don't see it in the list", about the one
    // place it should have appeared first. Empty recents is the whole point of
    // the case: it is the state a user is in immediately after naming one.
    const el = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={[]}
        configProfiles={[
          {
            id: 'p1',
            name: 'claude-manifest-lab',
            dir: '/Users/me/lab/.claude',
            color: 'blue',
          },
        ]}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(options(el).map((o) => o.textContent)).toEqual([
      // `Default profile` LEADS them: with named profiles on screen it is one
      // of the same kind of choice — the CLI's own account — rather than a
      // neighbour of the browse row it used to sit beside.
      'Default profile',
      'claude-manifest-lab',
      'Choose config directory…',
    ]);
  });

  it('marks the default row when nothing is picked', () => {
    // Its value is a SENTINEL, so the menu's own value comparison can never
    // match the `null` it stands for — as an `action` row it additionally
    // rendered no checkmark column at all. Between them, a picker sitting on
    // its default marked NONE of its rows, which is the state most users are
    // in most of the time.
    const el = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={[]}
        configProfiles={[
          {
            id: 'p1',
            name: 'claude-manifest-lab',
            dir: '/Users/me/lab/.claude',
            color: 'blue',
          },
        ]}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    const checked = options(el).filter(
      (o) => o.getAttribute('aria-selected') === 'true',
    );
    expect(checked.map((o) => o.textContent)).toEqual(['Default profile']);
  });

  it('names a profile once, not twice, when it is also a recent', () => {
    // A profile the user HAS picked is in both lists. Listing it from each
    // would offer one account as two rows — its name and its path — which
    // reads as two accounts.
    const el = render(
      <ConfigDirSelect
        configDir="/Users/me/lab/.claude"
        recentConfigDirs={['/Users/me/lab/.claude', ...RECENTS]}
        configProfiles={[
          {
            id: 'p1',
            name: 'claude-manifest-lab',
            dir: '/Users/me/lab/.claude',
            color: 'blue',
          },
        ]}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(options(el).map((o) => o.textContent)).toEqual([
      'Default profile',
      'claude-manifest-lab',
      '…/me/profiles/work',
      '…/me/profiles/personal',
      'Choose config directory…',
    ]);
    // And the CHIP says the name too — the leaf is what naming it was meant to
    // stop you reading, and two accounts routinely both live in `.claude`.
    expect(trigger(el)!.textContent).toContain('claude-manifest-lab');
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

  it('says who it is choosing FOR, so the builder does not claim to speak for chats', () => {
    // The graph builder's node inspector uses this same chip. Its default
    // wording — "for new chats" — is the one thing about the control that is
    // untrue there, and it is the whole label a screen reader reads out.
    const chats = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={[]}
        unavailableReason={null}
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(trigger(chats)!.getAttribute('aria-label')).toBe(
      'Agent config directory for new chats',
    );
    expect(trigger(chats)!.title).toContain('new chats run as');

    act(() => root?.unmount());
    container?.remove();

    const node = render(
      <ConfigDirSelect
        configDir={null}
        recentConfigDirs={[]}
        unavailableReason={null}
        ariaLabel="Agent config directory for this node"
        hint="Optional: the profile this node runs as"
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(trigger(node)!.getAttribute('aria-label')).toBe(
      'Agent config directory for this node',
    );
    expect(trigger(node)!.title).toBe(
      'Optional: the profile this node runs as',
    );
  });

  it('prefers the chosen PATH over either wording on hover', () => {
    // The hint answers "what is this for" while nothing is chosen; once one is,
    // the question is "which one", and only the full path answers that — the
    // chip itself shows the leaf.
    const el = render(
      <ConfigDirSelect
        configDir={RECENTS[0]!}
        recentConfigDirs={RECENTS}
        unavailableReason={null}
        hint="Optional: the profile this node runs as"
        onChange={() => {}}
        onBrowse={() => {}}
      />,
    );
    expect(trigger(el)!.title).toBe(RECENTS[0]);
  });
});
