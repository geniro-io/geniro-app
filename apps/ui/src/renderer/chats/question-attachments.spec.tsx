// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STUB_PICTURE_DATA_URL,
  stubThreadContextReader,
} from '../__fixtures__/thread-context-reader';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import type { PublishedArtifact } from './published-artifact';
import {
  PAGE_UNAVAILABLE_TEXT,
  QuestionAttachments,
} from './question-attachments';
import type { QuestionAttachmentSet } from './question-attachments-payload';
import {
  type ThreadContextReader,
  ThreadContextReaderContext,
} from './thread-question-context';
import { ThreadOpenContext } from './thread-title';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const PLAN: PublishedArtifact = {
  artifactId: 'plan',
  version: 2,
  title: 'Plan for the cache',
  summary: null,
  key: 'key-plan',
};

const PLAN_SET: QuestionAttachmentSet = {
  attachments: [
    {
      kind: 'artifact',
      artifactId: 'plan',
      title: 'Plan for the cache',
      version: 2,
    },
  ],
  moreAttachments: 0,
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function readerWith(
  listing: PublishedArtifact[] | 'failed',
): ThreadContextReader {
  return stubThreadContextReader(() => Promise.resolve([]), {
    artifacts: () =>
      listing === 'failed'
        ? Promise.reject(new Error('listing unreadable'))
        : Promise.resolve(listing),
    loadImage: () => () => Promise.resolve(STUB_PICTURE_DATA_URL),
  });
}

async function draw(
  ui: React.ReactNode,
  reader: ThreadContextReader | null,
  open?: (runId: string) => void,
): Promise<void> {
  await act(async () => {
    root.render(
      <ThreadOpenContext.Provider value={open ?? null}>
        <ThreadContextReaderContext.Provider value={reader}>
          {ui}
        </ThreadContextReaderContext.Provider>
      </ThreadOpenContext.Provider>,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

function buttonsNamed(name: string): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (button) => button.getAttribute('aria-label') === name,
  );
}

function chips(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-slot="question-attachment-chip"]',
    ),
  ];
}

describe('QuestionAttachments preview variant', () => {
  it('draws a page inline with one labelled full-screen button beside its title', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="preview"
      />,
      readerWith([PLAN]),
    );

    const labelled = [...document.querySelectorAll('button')].filter(
      (button) => button.textContent?.trim() === 'Open full screen',
    );
    expect(labelled).toHaveLength(1);
    expect(labelled[0]?.getAttribute('aria-label')).toBe(
      'Open Plan for the cache full screen',
    );
    expect(document.querySelector('iframe')).not.toBeNull();
  });

  it('keeps the corner control out of the accessibility tree so the labelled button is the only one with its name', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="preview"
      />,
      readerWith([PLAN]),
    );

    const named = buttonsNamed('Open Plan for the cache full screen');
    expect(named).toHaveLength(2);
    expect(
      named.filter((button) => button.closest('[aria-hidden="true"]') === null),
    ).toHaveLength(1);
  });

  it('draws the unavailable placeholder, and no page, when the listing does not hold the page', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="preview"
      />,
      readerWith([]),
    );

    expect(container.textContent).toContain(PAGE_UNAVAILABLE_TEXT);
    expect(document.querySelector('iframe')).toBeNull();
    expect(buttonsNamed('Open Plan for the cache full screen')).toHaveLength(0);
  });

  it('draws the same placeholder when the listing cannot be read', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="preview"
      />,
      readerWith('failed'),
    );

    expect(container.textContent).toContain(PAGE_UNAVAILABLE_TEXT);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('draws a picture set with its gallery card', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{
          attachments: [
            {
              kind: 'gallery',
              seq: 7,
              gallery: {
                title: 'Trip',
                images: [
                  {
                    path: 'a.png',
                    caption: null,
                    description: null,
                    source: null,
                  },
                ],
              },
            },
          ],
          moreAttachments: 0,
        }}
        variant="preview"
      />,
      readerWith([]),
    );

    expect(document.querySelector('[data-slot="gallery-card"]')).not.toBeNull();
  });

  it('names the rest as plain text when there is no thread to open', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{ ...PLAN_SET, moreAttachments: 2 }}
        variant="preview"
      />,
      readerWith([PLAN]),
    );

    const more = document.querySelector(
      '[data-slot="question-attachments-more"]',
    );
    expect(more?.textContent).toBe('+2 more');
    expect(more?.tagName).toBe('SPAN');
  });

  it('opens the thread from +N more when the thread can be opened', async () => {
    const opened = vi.fn();
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{ ...PLAN_SET, moreAttachments: 2 }}
        variant="preview"
      />,
      readerWith([PLAN]),
      opened,
    );

    const more = document.querySelector<HTMLButtonElement>(
      '[data-slot="question-attachments-more"]',
    );
    expect(more?.tagName).toBe('BUTTON');
    act(() => more?.click());
    expect(opened).toHaveBeenCalledWith('thread-1');
  });
});

describe('QuestionAttachments chips variant', () => {
  it('draws one chip per page, named by its full title, and loads no page until it is pressed', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="chips"
      />,
      readerWith([PLAN]),
    );

    expect(chips()).toHaveLength(1);
    expect(chips()[0]?.getAttribute('aria-label')).toBe('Plan for the cache');
    expect(chips()[0]?.getAttribute('title')).toBe('Plan for the cache');
    expect(document.querySelector('iframe')).toBeNull();

    act(() => chips()[0]?.click());

    expect(document.querySelector('iframe')).not.toBeNull();
  });

  it('reads an unavailable chip as the title with "unavailable"', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="chips"
      />,
      readerWith([]),
    );

    expect(chips()[0]?.getAttribute('aria-label')).toBe(
      'Plan for the cache, unavailable',
    );
    expect(chips()[0]?.disabled).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('names a picture set "N pictures · title" and opens its pictures when pressed', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{
          attachments: [
            {
              kind: 'gallery',
              seq: 9,
              gallery: {
                title: 'Trip',
                images: [
                  {
                    path: 'a.png',
                    caption: null,
                    description: null,
                    source: null,
                  },
                  {
                    path: 'b.png',
                    caption: null,
                    description: null,
                    source: null,
                  },
                ],
              },
            },
          ],
          moreAttachments: 0,
        }}
        variant="chips"
      />,
      readerWith([]),
    );

    expect(chips()[0]?.getAttribute('aria-label')).toBe('2 pictures · Trip');
    expect(document.querySelector('[data-slot="gallery-card"]')).toBeNull();

    act(() => chips()[0]?.click());

    expect(document.querySelector('[data-slot="gallery-card"]')).not.toBeNull();
  });

  it("draws no page in the thread's own card when the question names none", async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{ attachments: [], moreAttachments: 0 }}
        variant="chips"
      />,
      readerWith([PLAN]),
    );

    expect(chips()).toHaveLength(0);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('draws nothing without a thread reader', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={PLAN_SET}
        variant="chips"
      />,
      null,
    );

    expect(container.innerHTML).toBe('');
  });
});
