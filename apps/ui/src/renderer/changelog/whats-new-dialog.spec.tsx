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
    sections: [
      {
        kind: 'new',
        entries: [{ text: 'Third', description: 'Why it helps.' }],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-02-01',
    sections: [{ kind: 'fixed', entries: [{ text: 'Second' }] }],
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

function entryLines(): string[] {
  return [
    ...container.querySelectorAll('[data-slot="changelog-digest"] li'),
  ].map((node) => node.textContent ?? '');
}

describe('WhatsNewDialog', () => {
  it('heads the list with the range from the last seen version to the running one', () => {
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES}
          since="1.1.0"
          current="1.3.0"
          onClose={() => undefined}
          onOpenFullChangelog={() => undefined}
        />,
      ),
    );

    const range = container.querySelector('[data-slot="whats-new-range"]');
    expect(range?.textContent).toContain('1.1.0');
    expect(range?.textContent).toContain('1.3.0');
    expect(range?.textContent).toContain('You updated from 1.1.0 to 1.3.0');
  });

  it('shows every release’s changes as one list, each tagged with its release and described, no cards', () => {
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES}
          since="1.1.0"
          current="1.3.0"
          onClose={() => undefined}
          onOpenFullChangelog={() => undefined}
        />,
      ),
    );

    expect(
      container.querySelectorAll('[data-slot="changelog-digest"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-slot="changelog-release"]'),
    ).toBeNull();
    expect(entryLines()).toEqual(['Third1.3.0Why it helps.', 'Second1.2.0']);
    expect(
      container.querySelector('[data-slot="changelog-entry-description"]')
        ?.textContent,
    ).toBe('Why it helps.');
  });

  it('fills the window and scrolls the changes alone, under a fixed range and buttons', () => {
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES}
          since="1.1.0"
          current="1.3.0"
          onClose={() => undefined}
          onOpenFullChangelog={() => undefined}
        />,
      ),
    );

    const card = container.querySelector('[role="dialog"] > div[tabindex]');
    expect(card?.classList.contains('h-full')).toBe(true);
    expect(card?.classList.contains('max-w-none')).toBe(true);
    const body = container.querySelector('[data-slot="whats-new-body"]');
    expect(body?.classList.contains('overflow-y-auto')).toBe(true);
    expect(
      body?.querySelector('[data-slot="changelog-digest"]'),
    ).not.toBeNull();
    expect(body?.querySelector('[data-slot="whats-new-range"]')).toBeNull();
  });

  it('names only the running version when the profile had none recorded', () => {
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES.slice(0, 1)}
          since={null}
          current="1.3.0"
          onClose={() => undefined}
          onOpenFullChangelog={() => undefined}
        />,
      ),
    );

    const range = container.querySelector('[data-slot="whats-new-range"]');
    expect(range?.textContent).toBe('1.3.0What changed in this version.');
    expect(entryLines()).toEqual(['ThirdWhy it helps.']);
  });

  it('closes on Got it and opens the full changelog on its button', () => {
    const onClose = vi.fn();
    const onOpenFullChangelog = vi.fn();
    act(() =>
      root.render(
        <WhatsNewDialog
          open
          releases={RELEASES.slice(0, 1)}
          since="1.2.0"
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
