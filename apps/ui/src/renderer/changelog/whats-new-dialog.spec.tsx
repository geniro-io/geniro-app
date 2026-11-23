// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangelogRelease } from '../../shared/changelog';
import { WhatsNewDialog } from './whats-new-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RELEASES: ChangelogRelease[] = [
  {
    version: '1.3.0',
    date: '2026-03-01',
    sections: [{ kind: 'new', entries: ['Third'] }],
  },
  {
    version: '1.2.0',
    date: '2026-02-01',
    sections: [{ kind: 'fixed', entries: ['Second'] }],
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (node) => node.textContent === label,
  )!;
}

describe('WhatsNewDialog', () => {
  it('lists every skipped release, marks the running one and says how many', () => {
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES}
          current="1.3.0"
          onClose={() => undefined}
          onOpenFullChangelog={() => undefined}
        />,
      ),
    );

    expect(container.textContent).toContain('What’s new in Geniro 1.3.0');
    expect(container.textContent).toContain(
      'in the 2 versions since you last looked',
    );
    expect(
      container.querySelector('[aria-label="Version 1.3.0"]')?.textContent,
    ).toContain('Current version');
    expect(
      container.querySelector('[aria-label="Version 1.2.0"]'),
    ).not.toBeNull();
  });

  it('closes on Got it and opens the full changelog on its button', () => {
    const onClose = vi.fn();
    const onOpenFullChangelog = vi.fn();
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES.slice(0, 1)}
          current="1.3.0"
          onClose={onClose}
          onOpenFullChangelog={onOpenFullChangelog}
        />,
      ),
    );

    act(() => button('Got it').click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => button('Full changelog').click());
    expect(onOpenFullChangelog).toHaveBeenCalledTimes(1);
  });
});
