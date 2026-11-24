// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenReviewCommentContext,
  ReviewMessageCard,
} from './review-message-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const REVIEW = {
  note: 'Please look at both.',
  comments: [
    {
      number: 1,
      folder: '/work/shop',
      path: 'src/a.ts',
      side: 'new' as const,
      startLine: 12,
      endLine: 12,
      quote: 'const total = 0;',
      body: 'Extract the sum.',
    },
    {
      number: 2,
      folder: '/work/shop',
      path: 'src/b.ts',
      side: 'file' as const,
      startLine: null,
      endLine: null,
      quote: '',
      body: 'Split this file.',
    },
  ],
};

async function mount(open: ((number: number) => void) | null): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <OpenReviewCommentContext.Provider value={open}>
        <ReviewMessageCard review={REVIEW} />
      </OpenReviewCommentContext.Provider>,
    );
  });
}

describe('ReviewMessageCard', () => {
  it('lists every comment the review carried with its file, lines, quote and body', async () => {
    await mount(null);
    const text = container!.textContent ?? '';

    expect(text).toContain('Review · 2 comments in 2 files');
    expect(text).toContain('Please look at both.');
    expect(text).toContain('#1 · src/a.ts · Line 12');
    expect(text).toContain('const total = 0;');
    expect(text).toContain('#2 · src/b.ts · Whole file');
    expect(text).toContain('Split this file.');
    expect(text).not.toContain('Open in review');
  });

  it('opens the review screen at the comment pressed', async () => {
    const open = vi.fn();
    await mount(open);

    const buttons = [...container!.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Open in review',
    );
    await act(async () => {
      buttons[1]!.click();
    });

    expect(open).toHaveBeenCalledWith(2);
  });
});
