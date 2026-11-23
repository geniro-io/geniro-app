// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangelogRelease } from '../../shared/changelog';
import { CHANGELOG_PAGE, ChangelogPage, filterReleases } from './changelog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const RELEASES: ChangelogRelease[] = [
  {
    version: '1.2.0',
    date: '2026-03-02',
    sections: [
      { kind: 'new', entries: ['Search the changelog', 'Dark sidebar'] },
      { kind: 'fixed', entries: ['Keep the dialog open'] },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-02-01',
    sections: [{ kind: 'fixed', entries: ['Faster search results'] }],
  },
];

function manyReleases(count: number): ChangelogRelease[] {
  return Array.from({ length: count }, (_, index) => ({
    version: `1.${count - index}.0`,
    date: '2026-01-01',
    sections: [{ kind: 'fixed' as const, entries: [`Fix ${count - index}`] }],
  }));
}

describe('filterReleases', () => {
  it('keeps only entries containing the query, case-insensitively, and drops emptied releases', () => {
    expect(filterReleases(RELEASES, 'SEARCH', null)).toEqual([
      {
        ...RELEASES[0],
        sections: [{ kind: 'new', entries: ['Search the changelog'] }],
      },
      RELEASES[1],
    ]);
  });

  it('narrows to one kind of change', () => {
    expect(filterReleases(RELEASES, '', 'new').map((r) => r.version)).toEqual([
      '1.2.0',
    ]);
  });

  it('keeps a whole release when the query names its version', () => {
    expect(filterReleases(RELEASES, '1.2.0', null)).toEqual([RELEASES[0]]);
  });
});

describe('ChangelogPage', () => {
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

  const versions = (): (string | null)[] =>
    [...container.querySelectorAll('[data-slot="changelog-release"]')].map(
      (node) => node.getAttribute('aria-label'),
    );

  it('marks the running version and narrows the list as the user types', () => {
    act(() =>
      root.render(<ChangelogPage releases={RELEASES} current="1.1.0" />),
    );

    const current = container.querySelector('[aria-label="Version 1.1.0"]');
    expect(current?.textContent).toContain('Current version');

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search the changelog"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'dialog');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(versions()).toEqual(['Version 1.2.0']);
    expect(container.textContent).toContain('1 matching change in 1 version');
  });

  it('shows the newest releases first and the rest behind Show all', () => {
    const releases = manyReleases(CHANGELOG_PAGE + 5);
    act(() =>
      root.render(<ChangelogPage releases={releases} current={null} />),
    );

    expect(versions()).toHaveLength(CHANGELOG_PAGE);
    expect(versions()[0]).toBe(`Version 1.${CHANGELOG_PAGE + 5}.0`);

    const showAll = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Show all'),
    )!;
    act(() => showAll.click());

    expect(versions()).toHaveLength(CHANGELOG_PAGE + 5);
  });

  async function choose(label: string, option: string): Promise<void> {
    const trigger = container.querySelector<HTMLElement>(
      `[data-menu-trigger][aria-label="${label}"]`,
    )!;
    await act(async () => trigger.click());
    const item = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((candidate) => candidate.textContent?.trim() === option)!;
    await act(async () => item.click());
  }

  it('jumps to a version behind Show all by revealing it and scrolling to its card', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    try {
      const releases = manyReleases(CHANGELOG_PAGE + 5);
      act(() =>
        root.render(<ChangelogPage releases={releases} current={null} />),
      );

      await choose('Jump to version', '1.1.0');

      expect(versions()).toHaveLength(CHANGELOG_PAGE + 5);
      expect(scrolled.map((element) => element.id)).toEqual(['release-1.1.0']);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('narrows the list to one kind of change from its menu', async () => {
    act(() =>
      root.render(<ChangelogPage releases={RELEASES} current={null} />),
    );

    await choose('Kind of change', 'New');

    expect(versions()).toEqual(['Version 1.2.0']);
    expect(container.textContent).not.toContain('Keep the dialog open');
  });
});
