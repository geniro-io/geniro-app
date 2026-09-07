// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FolderSelect } from './folder-select';

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

const RECENTS = ['/Users/me/code/geniro-app', '/Users/me/code/price-crawler'];

describe('FolderSelect', () => {
  it('draws NO second line — a folder never carries a name', () => {
    // The blast-radius guard, and the reason `DirectorySelect`'s two-line row
    // is gated rather than unconditional. This picker and the config-directory
    // one are the SAME component; the config one passes a `named` map and this
    // one passes none. Ungated, every folder row here would gain a second line
    // with nothing to put on it — on the landing composer and in the
    // run-configuration editor — because a working folder is a directory that
    // is never given a name.
    const el = render(
      <FolderSelect
        folder={RECENTS[0]!}
        recentFolders={RECENTS}
        onChoose={() => {}}
        onBrowse={() => {}}
      />,
    );

    const rows = options(el);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('[data-slot="menu-item-sublabel"]')).toBeNull();
    }
  });

  it('keeps the PATH on the row, since the leaf alone cannot tell two apart', () => {
    // The other half of the same decision. With a line underneath, a leaf is
    // enough to lead with; without one it is not — two checkouts of one repo
    // are both `geniro-app`. So the one-line form still says the path, elided
    // from the FRONT, which is the end the rows share.
    const el = render(
      <FolderSelect
        folder={null}
        recentFolders={['/Users/me/a/geniro-app', '/Users/me/b/geniro-app']}
        onChoose={() => {}}
        onBrowse={() => {}}
      />,
    );

    const labels = options(el).map(
      (o) => o.querySelector('[data-slot="menu-item-label"]')?.textContent,
    );

    expect(labels).toContain('…/me/a/geniro-app');
    expect(labels).toContain('…/me/b/geniro-app');
  });

  it('reports the whole path, never the elided label the row shows', () => {
    const onChoose = vi.fn();
    const el = render(
      <FolderSelect
        folder={null}
        recentFolders={RECENTS}
        onChoose={onChoose}
        onBrowse={() => {}}
      />,
    );

    const rows = options(el);
    act(() => {
      rows[0]!.click();
    });

    expect(onChoose).toHaveBeenCalledWith(RECENTS[0]);
  });
});
