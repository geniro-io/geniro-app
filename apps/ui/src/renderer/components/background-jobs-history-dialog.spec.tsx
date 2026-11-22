// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BACKGROUND_JOBS, JOBS_NOW } from '../__fixtures__/background-jobs';
import { BackgroundJobsHistoryDialog } from './background-jobs-history-dialog';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(
  props: Partial<Parameters<typeof BackgroundJobsHistoryDialog>[0]>,
) {
  const handlers = { onClose: vi.fn(), onLoadMore: vi.fn() };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <BackgroundJobsHistoryDialog
        open
        jobs={BACKGROUND_JOBS.finished}
        hasMore
        loading={false}
        error={null}
        now={JOBS_NOW}
        {...handlers}
        {...props}
      />,
    ),
  );
  return handlers;
}

function loadMore(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Load more',
  );
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('BackgroundJobsHistoryDialog', () => {
  it('lists every run it was given and reads the next page on Load more', () => {
    const { onLoadMore } = mount({});

    expect(
      document.querySelectorAll('[data-slot="background-job"]'),
    ).toHaveLength(3);
    act(() => loadMore()?.click());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers no Load more on the last page', () => {
    mount({ hasMore: false });

    expect(loadMore()).toBeUndefined();
  });

  it('says nothing has run yet when there is no run', () => {
    mount({ jobs: [], hasMore: false });

    expect(document.body.textContent).toContain(
      'Nothing has run in the background yet.',
    );
  });
});
