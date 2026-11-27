// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

const REPORT: PublishedArtifact = {
  artifactId: 'report',
  version: 1,
  title: 'Report',
  summary: null,
  key: 'key-report',
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

  it('draws exactly the pages it names, each inline once and in order', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{
          attachments: [
            { ...PLAN_SET.attachments[0]!, title: 'Plan for the cache' },
            {
              kind: 'artifact',
              artifactId: 'report',
              title: 'Report',
              version: 1,
            },
          ],
        }}
        variant="preview"
      />,
      readerWith([PLAN, REPORT]),
    );

    expect(document.querySelectorAll('iframe')).toHaveLength(2);
    expect(buttonsNamed('Open Plan for the cache full screen')).toHaveLength(2);
    expect(buttonsNamed('Open Report full screen')).toHaveLength(2);
  });

  it('draws no attachments block and no "+N more" line when the set names no page', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{ attachments: [] }}
        variant="preview"
      />,
      readerWith([PLAN]),
      () => undefined,
    );

    expect(
      document.querySelector('[data-slot="question-attachments"]'),
    ).toBeNull();
    expect(container.textContent).toBe('');
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

  it('draws one chip for each page the set names, in its order', async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{
          attachments: [
            {
              kind: 'artifact',
              artifactId: 'report',
              title: 'Report',
              version: 1,
            },
            { ...PLAN_SET.attachments[0]! },
          ],
        }}
        variant="chips"
      />,
      readerWith([PLAN, REPORT]),
    );

    expect(chips().map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Report',
      'Plan for the cache',
    ]);
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

  it("draws no page in the thread's own card when the question names none", async () => {
    await draw(
      <QuestionAttachments
        threadRunId="thread-1"
        set={{ attachments: [] }}
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
