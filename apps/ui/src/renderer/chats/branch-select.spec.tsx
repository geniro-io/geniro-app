// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GitInfo } from '../../shared/contracts';
import { BranchSelect } from './branch-select';

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
});
