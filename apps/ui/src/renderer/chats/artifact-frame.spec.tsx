// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ArtifactFrame } from './artifact-frame';
import {
  ArtifactUrlContext,
  type PublishedArtifact,
} from './published-artifact';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ARTIFACT: PublishedArtifact = {
  artifactId: 'plan',
  version: 2,
  title: 'Migration plan',
  summary: null,
  key: 'k'.repeat(64),
};

const URL = 'http://127.0.0.1:47615/v1/artifacts/run-1/plan?key=kkk&v=2';

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
});

async function render(
  artifact: PublishedArtifact = ARTIFACT,
  url: string | null = URL,
): Promise<void> {
  await act(async () => {
    root.render(
      <ArtifactUrlContext.Provider value={url === null ? null : () => url}>
        <ArtifactFrame artifact={artifact} />
      </ArtifactUrlContext.Provider>,
    );
  });
}

const frame = (): HTMLIFrameElement | null => container.querySelector('iframe');

describe('ArtifactFrame', () => {
  it('frames the page the url builder names', async () => {
    await render();
    expect(frame()?.getAttribute('src')).toBe(URL);
    expect(frame()?.getAttribute('title')).toBe('Migration plan');
  });

  it('sandboxes with allow-scripts and grants NOTHING else', async () => {
    // Exact equality, so ANY added flag reddens this — `allow-same-origin`
    // above all, since a frame granted it alongside `allow-scripts` can reach
    // its own `sandbox` attribute and remove it, and would then sit in this
    // app's origin beside the loopback token. The others that would each
    // undo part of the containment: allow-top-navigation(-by-user-activation),
    // allow-popups, allow-modals, allow-downloads, allow-forms,
    // allow-pointer-lock, allow-presentation.
    await render();
    expect(frame()?.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('sends no referrer to the page', async () => {
    await render();
    expect(frame()?.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('says so plainly when there is no way to address the page', async () => {
    // Outside a provider the builder is null. A frame pointed at a URL the
    // component had to invent would be worse than a sentence.
    await render(ARTIFACT, null);
    expect(frame()).toBeNull();
    expect(container.textContent).toContain('cannot be opened');
  });

  it('reloads on a republish rather than reusing the element', async () => {
    // Keyed by version: React would otherwise keep the same iframe, which goes
    // on showing the document it has already loaded.
    await render();
    const first = frame();
    expect(first).not.toBeNull();

    await render({ ...ARTIFACT, version: 3 }, 'http://127.0.0.1:47615/a?v=3');

    expect(frame()).not.toBe(first);
    expect(frame()?.getAttribute('src')).toBe('http://127.0.0.1:47615/a?v=3');
  });

  it('grows to the height its page reports', async () => {
    await render();
    const target = frame();
    expect(target).not.toBeNull();
    // The real page posts this from inside the sandbox; jsdom gives the frame
    // a contentWindow, which is what the listener filters on.
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 400 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe('400px');
  });

  it('ignores a height from anything that is not its own frame', async () => {
    // Another artifact's frame, or any other embedded document, must not be
    // able to resize this one.
    await render();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 999 },
          source: window,
        }),
      );
    });
    expect(frame()?.style.height).not.toBe('999px');
  });

  it('ignores a message that is not tagged as an artifact’s', async () => {
    await render();
    const target = frame();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'something-else', type: 'height', height: 999 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).not.toBe('999px');
  });

  it('does not collapse on a page that measures itself as nothing', async () => {
    // Zero is a page mid-layout, not a page of no height — collapsing there
    // makes the artifact vanish.
    await render();
    const target = frame();
    const before = frame()?.style.height;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 0 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe(before);
  });

  it('caps its own growth so one artifact cannot own the transcript', async () => {
    await render();
    const target = frame();
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'height', height: 99_000 },
          source: target!.contentWindow,
        }),
      );
    });
    expect(frame()?.style.height).toBe('520px');
  });
});
