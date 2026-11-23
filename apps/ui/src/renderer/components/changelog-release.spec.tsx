// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChangelogReleaseCard } from './changelog-release';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('ChangelogReleaseCard', () => {
  it('draws each kind of change under its heading with bold and code spans', () => {
    act(() =>
      root.render(
        <ChangelogReleaseCard
          release={{
            version: '1.2.0',
            date: '2026-03-02',
            sections: [
              { kind: 'new', entries: ['**Search:** find `any` entry'] },
              { kind: 'fixed', entries: ['Plain fix'] },
            ],
          }}
        />,
      ),
    );

    const card = container.querySelector('#release-1\\.2\\.0')!;
    expect(card.querySelector('h3')?.textContent).toBe('1.2.0');
    expect(card.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-03-02',
    );
    expect(
      [...card.querySelectorAll('section')].map((s) => s.dataset.kind),
    ).toEqual(['new', 'fixed']);
    expect(card.querySelector('strong')?.textContent).toBe('Search:');
    expect(card.querySelector('code')?.textContent).toBe('any');
    expect(card.textContent).not.toContain('**');
    expect(card.textContent).not.toContain('Current version');
  });

  it('names a release not shipped yet and draws no date', () => {
    act(() =>
      root.render(
        <ChangelogReleaseCard
          release={{
            version: null,
            date: null,
            sections: [{ kind: 'fixed', entries: ['Soon'] }],
          }}
        />,
      ),
    );

    expect(container.querySelector('h3')?.textContent).toBe('Not released yet');
    expect(container.querySelector('time')).toBeNull();
  });
});
