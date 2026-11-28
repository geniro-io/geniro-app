// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openRequest } from '../__fixtures__/open-requests';
import {
  STUB_PICTURE_DATA_URL,
  stubThreadContextReader,
} from '../__fixtures__/thread-context-reader';
import { ThreadContextReaderContext } from '../chats/thread-question-context';
import { RequestCard } from './request-card';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PICTURE_QUESTIONS = [
  {
    question: 'Is this layout right? ![pic](/tmp/shots/layout.png)',
    header: 'Layout',
    options: [{ label: 'Yes' }, { label: 'No' }],
  },
];

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

describe('RequestCard', () => {
  it("draws a picture in the question, read from the thread's own run", async () => {
    const loads: string[] = [];
    const reader = stubThreadContextReader(vi.fn().mockResolvedValue([]), {
      loadImage: (threadRunId) => (path) => {
        loads.push(`${threadRunId} ${path}`);
        return Promise.resolve(STUB_PICTURE_DATA_URL);
      },
    });

    await act(async () => {
      root.render(
        <ThreadContextReaderContext.Provider value={reader}>
          <RequestCard
            request={openRequest('thread-q2', 'q-1', {
              toolName: 'AskUserQuestion',
              input: { questions: PICTURE_QUESTIONS },
              questions: PICTURE_QUESTIONS,
            })}
            onAnswer={vi.fn()}
          />
        </ThreadContextReaderContext.Provider>,
      );
      await Promise.resolve();
    });

    expect(loads).toEqual(['thread-q2 /tmp/shots/layout.png']);
    expect(
      container
        .querySelector('[data-slot="markdown-image"]')
        ?.getAttribute('src'),
    ).toBe(STUB_PICTURE_DATA_URL);
  });

  it('draws a chip for each page the question attached, which opens the page', async () => {
    const reader = stubThreadContextReader(vi.fn().mockResolvedValue([]), {
      artifacts: () =>
        Promise.resolve([
          {
            artifactId: 'q2-page',
            version: 1,
            title: 'Q2 page',
            summary: null,
            key: 'k',
          },
        ]),
    });

    await act(async () => {
      root.render(
        <ThreadContextReaderContext.Provider value={reader}>
          <RequestCard
            request={openRequest('thread-q2', 'q-1', {
              toolName: 'ask_user_question',
              input: { questions: PICTURE_QUESTIONS },
              questions: PICTURE_QUESTIONS,
              attachments: [
                {
                  kind: 'artifact',
                  artifactId: 'q2-page',
                  title: 'Q2 page',
                  version: 1,
                },
              ],
            })}
            onAnswer={vi.fn()}
          />
        </ThreadContextReaderContext.Provider>,
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    const chips = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[data-slot="question-attachment-chip"]',
      ),
    ];
    expect(chips.map((chip) => chip.textContent)).toEqual(['Q2 page']);
    expect(document.querySelector('iframe')).toBeNull();

    act(() => chips[0]!.click());

    expect(document.querySelector('iframe')).not.toBeNull();
  });
});
