// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('sandboxes with allow-scripts alone, and grants NOTHING else', async () => {
    // Exact equality, so ANY added flag reddens this — `allow-same-origin`
    // above all, since a frame granted it alongside `allow-scripts` can reach
    // its own `sandbox` attribute and remove it, and would then sit in this
    // app's origin beside the loopback token. allow-popups is NOT granted: a
    // link reaches the browser as a message to the host, so the page never
    // opens a window. Also refused: allow-popups-to-escape-sandbox,
    // allow-top-navigation(-by-user-activation), allow-modals, allow-downloads,
    // allow-forms, allow-pointer-lock, allow-presentation.
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

describe('ArtifactFrame — a link the page asks the host to open', () => {
  async function postLink(
    href: unknown,
    source: MessageEventSource | null = frame()?.contentWindow ?? null,
  ): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'geniro-artifact', type: 'link', href },
          source,
        }),
      );
    });
  }

  /** The address the host is offering, or null when no link is on offer. */
  const offeredAddress = (): string | null =>
    container.querySelector('.font-mono')?.textContent ?? null;

  /** The button that opens the offered link, or null when none is on offer. */
  const openButton = (): HTMLButtonElement | null =>
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Open link',
    ) ?? null;

  const dismissButton = (): HTMLButtonElement | null =>
    [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Dismiss',
    ) ?? null;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers a web link, and opens nothing until the reader presses its button', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    expect(offeredAddress()).toBe('https://example.com/a');
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the offered link in the browser when the reader presses its button', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    await act(async () => {
      openButton()?.click();
    });
    expect(open).toHaveBeenCalledWith(
      'https://example.com/a',
      '_blank',
      'noopener',
    );
    expect(offeredAddress()).toBeNull();
  });

  it('offers a mail link the same way', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('mailto:someone@example.com');
    expect(offeredAddress()).toBe('mailto:someone@example.com');
    await act(async () => {
      openButton()?.click();
    });
    expect(open).toHaveBeenCalledWith(
      'mailto:someone@example.com',
      '_blank',
      'noopener',
    );
  });

  it('offers a link with its address as the URL parser reads it, so the reader sees what will open', async () => {
    await render();
    await postLink('HTTPS://Example.com/a');
    expect(offeredAddress()).toBe('https://example.com/a');
  });

  it('opens nothing when the reader dismisses the offer', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a');
    await act(async () => {
      dismissButton()?.click();
    });
    expect(offeredAddress()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('offers nothing for a scheme the page may not open', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('javascript:alert(1)');
    await postLink('file:///etc/hosts');
    await postLink('other.html');
    expect(offeredAddress()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('ignores a link posted from anything that is not its own frame', async () => {
    await render();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await postLink('https://example.com/a', window);
    expect(offeredAddress()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
