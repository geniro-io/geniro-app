// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonHandle } from '../../shared/contracts';
import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { ThreadDonePages } from './thread-done-pages';
import {
  ThreadContextReaderContext,
  threadContextReaderOf,
} from './thread-question-context';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

const HANDLE: DaemonHandle = {
  host: '127.0.0.1',
  port: 47615,
  token: 'launch-token',
  version: '1.0.0',
  startedAt: '2026-11-28T00:00:00.000Z',
};

const PAGE = {
  artifactId: 'notes',
  version: 1,
  title: 'Release notes',
  summary: null,
  key: 'k',
  at: '2026-11-28T10:05:00.000Z',
  seq: 10,
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

function chipTitles(): string[] {
  return [
    ...container.querySelectorAll('[data-slot="question-attachment-chip"]'),
  ].map((chip) => chip.textContent ?? '');
}

describe('ThreadDonePages', () => {
  it('shows the pages a thread published after an earlier finish once it finishes again, in the same window', async () => {
    const readRunArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ artifacts: [] })
      .mockResolvedValue({ artifacts: [PAGE] });
    const reader = threadContextReaderOf(
      {
        listRunItems: vi.fn(),
        listCallMessages: vi.fn(),
        readLocalImage: vi.fn(),
        readArtifactAnswers: vi.fn(),
        saveArtifactAnswers: vi.fn(),
        readRunArtifacts,
      },
      HANDLE,
    );
    const draw = async (finishedAt: string): Promise<void> => {
      await act(async () => {
        root.render(
          <ThreadContextReaderContext.Provider value={reader}>
            <ThreadDonePages runId="run-1" finishedAt={finishedAt} />
          </ThreadContextReaderContext.Provider>,
        );
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    };

    await draw('2026-11-28T10:00:00.000Z');
    expect(chipTitles()).toEqual([]);

    await draw('2026-11-28T10:06:00.000Z');
    expect(chipTitles()).toHaveLength(1);
    expect(chipTitles()[0]).toContain('Release notes');
  });
});
