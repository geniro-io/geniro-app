// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactDialog } from './artifact-dialog';
import { BrowserPaneContext } from './browser/browser-pane-context';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ARTIFACT: PublishedArtifact = {
  artifactId: 'plan',
  version: 1,
  title: 'Migration plan',
  summary: null,
  key: 'k'.repeat(64),
};

const PAGE_URL = 'http://127.0.0.1:47615/v1/artifacts/run-1/plan?key=kkk&v=1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('ArtifactDialog — a link the full-screen page opens', () => {
  it('goes to the system browser even while the chat browser pane is open', async () => {
    const openUrl = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await act(async () => {
      root.render(
        <ArtifactUrlContext.Provider value={() => PAGE_URL}>
          <BrowserPaneContext.Provider
            value={{ openPane: vi.fn(), openUrl, isOpen: () => true }}>
            <ArtifactDialog artifact={ARTIFACT} open onClose={vi.fn()} />
          </BrowserPaneContext.Provider>
        </ArtifactUrlContext.Provider>,
      );
    });

    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'geniro-artifact',
            type: 'link',
            href: 'https://example.com/a',
          },
          source: frame?.contentWindow ?? null,
        }),
      );
    });

    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/a',
      '_blank',
      'noopener',
    );
    expect(openUrl).not.toHaveBeenCalled();
  });
});
