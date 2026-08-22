// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitInfo } from '../../shared/contracts';
import { BranchSelect, BranchValueSelect } from './branch-select';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(info: GitInfo): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <BranchSelect info={info} switching={false} onSwitch={vi.fn()} />,
    );
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

const REPO: GitInfo = {
  isRepo: true,
  branch: 'develop',
  branches: ['develop', 'main'],
  dirty: false,
  worktrees: [],
};

const classes = (el: Element): string[] =>
  (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

describe('BranchSelect', () => {
  it('renders nothing for a folder that is not a repository', () => {
    const el = render({ ...REPO, isRepo: false, branch: null, branches: [] });

    expect(el.querySelector('[data-menu-trigger]')).toBeNull();
  });

  it('is width-capped and does NOT shrink, so the folder chip absorbs a tight row', () => {
    // The composer row never wraps, so something must yield when it is
    // crowded. Flex sheds width in proportion to natural size, so letting this
    // shrink too would elide a short "develop" alongside the folder rather
    // than after it. The cap is what still bounds a long branch name.
    const trigger = render(REPO).querySelector('[data-menu-trigger]')!;

    // Exact tokens: the class list also carries `[&>svg]:shrink-0` for the icon.
    expect(classes(trigger)).toContain('shrink-0');
    expect(classes(trigger)).not.toContain('shrink');
    expect(classes(trigger)).toContain('max-w-40');
  });

  it('names the branch it is on', () => {
    const trigger = render(REPO).querySelector('[data-menu-trigger]')!;

    expect(trigger.textContent).toContain('develop');
  });

  it('says so on a detached HEAD rather than inventing a branch', () => {
    const trigger = render({ ...REPO, branch: null }).querySelector(
      '[data-menu-trigger]',
    )!;

    expect(trigger.textContent).toContain('detached HEAD');
  });

  it('marks a branch another worktree holds, and still lets it be picked', () => {
    // git will not check a branch out twice, so this row cannot switch the
    // folder — but it is not a dead end either: picking it is what produces the
    // strip's offer to run in the worktree that already has it. A DISABLED row
    // would take that route away and say nothing about where the branch is.
    const el = render({
      ...REPO,
      branches: ['develop', 'main', 'feat/elsewhere'],
      worktrees: [
        { branch: 'feat/elsewhere', path: '/repos/geniro-app-worktrees/side' },
      ],
    });
    const trigger = el.querySelector<HTMLElement>('[data-menu-trigger]')!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const rows = [...el.querySelectorAll<HTMLButtonElement>('[role="option"]')];

    const held = rows.find((row) =>
      row.textContent?.includes('feat/elsewhere'),
    );
    expect(held).toBeDefined();
    expect(held!.disabled).toBe(false);
    // The LEAF, not the whole path: a menu row carrying an absolute path pushes
    // every branch name out of view, and the offer states the path in full.
    expect(held!.textContent).toContain('in side');
    expect(held!.textContent).not.toContain('/repos/');
    // Every other branch is unmarked — the hint means something only if it is
    // not on all of them.
    const plain = rows.find((row) => row.textContent?.includes('main'));
    expect(plain!.textContent).not.toContain('in ');
  });
});

describe('BranchValueSelect', () => {
  /** Render the VALUE chip (records a name; never switches the checkout). */
  function renderValue(
    info: GitInfo,
    value: string | null,
  ): { el: HTMLDivElement; onChange: ReturnType<typeof vi.fn> } {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onChange = vi.fn();
    act(() => {
      root!.render(
        <BranchValueSelect info={info} value={value} onChange={onChange} />,
      );
    });
    return { el: container, onChange };
  }

  function openMenu(el: HTMLDivElement): HTMLElement[] {
    const trigger = el.querySelector<HTMLElement>('[data-menu-trigger]')!;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return [...el.querySelectorAll<HTMLElement>('[role="option"]')];
  }

  it('emits null for "whatever is checked out", never the empty sentinel', () => {
    // The sentinel exists only because `Select` cannot emit null. If it leaks
    // out, a saved configuration stores `branch: ''` — which the IPC refname
    // schema rejects, throwing away the ENTIRE settings patch, so the user's
    // save is silently lost.
    const { el, onChange } = renderValue(REPO, 'main');
    const row = openMenu(el).find((o) =>
      o.textContent?.includes('Whatever is checked out'),
    )!;
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(null);
    expect(onChange).not.toHaveBeenCalledWith('');
  });

  it('shows a stored branch the folder no longer has, rather than dropping it', () => {
    // The user's recorded answer survives a branch being deleted elsewhere —
    // the same add-back rule the model and effort chips follow for an off-list
    // value. Silently reading as unset would change their configuration.
    const { el } = renderValue(REPO, 'gone/branch');

    expect(
      openMenu(el).some((o) => o.textContent?.includes('gone/branch')),
    ).toBe(true);
    expect(el.querySelector('[data-menu-trigger]')?.textContent).toContain(
      'gone/branch',
    );
  });

  it('renders nothing for a folder that is not a repository', () => {
    const { el } = renderValue(
      {
        isRepo: false,
        branch: null,
        branches: [],
        dirty: false,
        worktrees: [],
      },
      null,
    );

    expect(el.querySelector('[data-menu-trigger]')).toBeNull();
  });
});
