// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PullRequestInfo, PullRequestState } from '../../shared/contracts';
import { CurrentPullRequestLine, PullRequestRow } from './pull-request-row';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pr(
  state: PullRequestState = 'open',
  isDraft = false,
): PullRequestInfo {
  return {
    number: 70,
    title: 'builder polish',
    state,
    isDraft,
    headRefName: 'fix/builder',
    isCrossRepository: false,
    headRepositoryOwner: 'someone',
    author: 'someone',
    url: 'https://github.com/o/r/pull/70',
    updatedAt: '2026-08-01T00:00:00Z',
  };
}

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

async function mount(ui: ReactNode): Promise<void> {
  await act(async () => {
    root.render(ui);
  });
}

describe('PullRequestRow', () => {
  it('links to the pull request and names its number', async () => {
    await mount(<PullRequestRow pullRequest={pr('merged')} />);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r/pull/70');
    // target=_blank so main's window-open handler routes it to the browser.
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.textContent).toContain('builder polish');
    expect(
      container.querySelector('[data-slot="panel-link-meta"]')?.textContent,
    ).toBe('#70');
  });

  it('states the state in the ICON, not as a word beside the number', async () => {
    // Asked for directly: every row carried a trailing `· merged` that said
    // what the glyph already said. The word has to stay reachable — the tooltip
    // and the icon's screen-reader text — since colour alone is not a label.
    await mount(<PullRequestRow pullRequest={pr('merged')} />);

    expect(
      container.querySelector('[data-slot="panel-link-meta"]')?.textContent,
    ).not.toContain('merged');
    expect(container.querySelector('a')?.getAttribute('title')).toContain(
      'merged',
    );
    expect(container.querySelector('.sr-only')?.textContent).toBe('merged');
  });

  it('colours the glyph by state', async () => {
    // Green merged, yellow open, grey draft, red closed — the whole visible
    // signal now that the word is gone, and every colour a token.
    const colourOf = async (
      state: PullRequestState,
      isDraft = false,
    ): Promise<string> => {
      await mount(<PullRequestRow pullRequest={pr(state, isDraft)} />);
      return container.querySelector('svg')?.getAttribute('class') ?? '';
    };

    expect(await colourOf('merged')).toContain('text-success');
    expect(await colourOf('open')).toContain('text-warning');
    expect(await colourOf('open', true)).toContain('text-muted-foreground');
    expect(await colourOf('closed')).toContain('text-destructive');
  });

  it('calls a draft a draft rather than open', async () => {
    // A draft listed as plain `open` would say it is asking for review when it
    // is not.
    await mount(<PullRequestRow pullRequest={pr('open', true)} />);

    expect(container.textContent).toContain('draft');
    expect(container.textContent).not.toContain('open');
  });
});

describe('CurrentPullRequestLine', () => {
  it('renders a link when it is interactive', async () => {
    await mount(
      <CurrentPullRequestLine pullRequest={pr()} interactive={true} />,
    );

    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://github.com/o/r/pull/70',
    );
  });

  it('renders NO anchor when it is not interactive', async () => {
    // The sidebar row is itself an activatable element: an anchor nested in one
    // is invalid markup and steals the row's own click, so this is a
    // correctness pin rather than a styling preference.
    await mount(<CurrentPullRequestLine pullRequest={pr()} />);

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('#70');
  });
});
