// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_JOBS,
  JOBS_NOW,
  NO_BACKGROUND_JOBS,
} from '../__fixtures__/background-jobs';
import { BackgroundJobsButton } from './background-jobs-button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(props: Partial<Parameters<typeof BackgroundJobsButton>[0]>) {
  const handlers = {
    onOpenChange: vi.fn(),
    onOpenThread: vi.fn(),
    onReview: vi.fn(),
    onShowHistory: vi.fn(),
  };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <BackgroundJobsButton
        open
        data={BACKGROUND_JOBS}
        error={null}
        now={JOBS_NOW}
        {...handlers}
        {...props}
      />,
    ),
  );
  return handlers;
}

function rows(): Element[] {
  return [...document.querySelectorAll('[data-slot="background-job"]')];
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('BackgroundJobsButton', () => {
  it('shows a spinner and the count while jobs run or wait, and a quiet glyph otherwise', () => {
    mount({ open: false });
    const trigger = document.querySelector(
      '[data-slot="background-jobs-trigger"]',
    );
    expect(
      trigger?.querySelector('[data-slot="background-jobs-count"]')
        ?.textContent,
    ).toBe('2');
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Background work — 2 running or queued',
    );

    act(() => root?.unmount());
    host?.remove();
    mount({
      open: false,
      data: { ...BACKGROUND_JOBS, active: [], running: 0 },
    });
    expect(
      document.querySelector('[data-slot="background-jobs-count"]'),
    ).toBeNull();
  });

  it('lists active jobs first, then finished ones, each with where it stands or what it filed', () => {
    mount({});

    expect(rows().map((row) => row.getAttribute('data-status'))).toEqual([
      'running',
      'queued',
      'done',
      'done',
      'failed',
    ]);
    const results = [
      ...document.querySelectorAll('[data-slot="background-job-result"]'),
    ].map((result) => result.textContent);
    expect(results).toEqual([
      'Reading the thread…',
      'Waiting to start',
      '2 lessons saved · 1 lesson waiting for review',
      'No lessons found',
      "You've hit your weekly limit · resets 4pm",
    ]);
  });

  it('opens a job’s thread, the review of its lessons and the full history, closing itself each time', () => {
    const handlers = mount({});

    act(() => rows()[2]?.querySelector<HTMLButtonElement>('button')?.click());
    expect(handlers.onOpenThread).toHaveBeenCalledWith('run-1');

    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-slot="background-job-review"]')
        ?.click(),
    );
    expect(handlers.onReview).toHaveBeenCalledTimes(1);

    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-slot="background-jobs-history"]',
        )
        ?.click(),
    );
    expect(handlers.onShowHistory).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenChange).toHaveBeenCalledTimes(3);
    expect(handlers.onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('says nothing has run yet rather than drawing an empty panel', () => {
    mount({ data: NO_BACKGROUND_JOBS });

    expect(document.body.textContent).toContain(
      'Nothing has run in the background yet',
    );
  });
});
