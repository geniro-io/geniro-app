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
  it('links to the pull request and names its number and state', async () => {
    await mount(<PullRequestRow pullRequest={pr('merged')} />);

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r/pull/70');
    // target=_blank so main's window-open handler routes it to the browser.
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.textContent).toContain('builder polish');
    expect(link?.textContent).toContain('#70');
    // Spelled out, not left to the glyph: inside the settled group a merged
    // pull request and an abandoned one are the same row shape.
    expect(link?.textContent).toContain('merged');
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
