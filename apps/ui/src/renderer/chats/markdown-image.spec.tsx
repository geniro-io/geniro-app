// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownContent } from './markdown-content';
import {
  type MarkdownImageLoader,
  MarkdownImageLoaderContext,
} from './markdown-image';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
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

/** Render markdown with a loader in context and let its promise settle. */
async function render(
  content: string,
  load: MarkdownImageLoader | null,
): Promise<void> {
  await act(async () => {
    root.render(
      <MarkdownImageLoaderContext.Provider value={load}>
        <MarkdownContent content={content} />
      </MarkdownImageLoaderContext.Provider>,
    );
  });
}

const src = (): string | null =>
  container
    .querySelector('[data-slot="markdown-image"]')
    ?.getAttribute('src') ?? null;
const unavailable = (): string | null =>
  container.querySelector('[data-slot="markdown-image-unavailable"]')
    ?.textContent ?? null;

describe('an image an agent referenced from its own markdown', () => {
  it('renders an ABSOLUTE local path, which never used to appear at all', async () => {
    // The reported defect — "i dont see images". Two independent walls: the
    // renderer's CSP is `img-src 'self' data:`, so a `file:` source is refused
    // outright, and there is no other way for a plain `<img>` to reach a local
    // file. Measured in the author's own history, the references really written
    // were `/tmp/shots/02-transcript.png` and bare names like `a.png`.
    const load = vi.fn(async () => 'data:image/png;base64,AAA');

    await render('![shot](/tmp/shots/02-transcript.png)', load);

    expect(load).toHaveBeenCalledWith('/tmp/shots/02-transcript.png');
    expect(src()).toBe('data:image/png;base64,AAA');
  });

  it('asks for a RELATIVE reference exactly as written, for the daemon to resolve', async () => {
    // `a.png` resolves against the app's own origin in a browser, which has
    // nothing to do with the folder the agent was working in. Only the daemon
    // knows the run's cwd, so the reference must travel unchanged — a renderer
    // that "helpfully" absolutized it would have to guess that base.
    const load = vi.fn(async () => 'data:image/png;base64,BBB');

    await render('![chart](a.png)', load);

    expect(load).toHaveBeenCalledWith('a.png');
    expect(src()).toBe('data:image/png;base64,BBB');
  });

  it('does NOT fetch a remote image, and says so', async () => {
    // Local-first: this app makes no outbound requests, and an agent-authored
    // `![](https://…)` is exactly the beacon `img-src 'self' data:` exists to
    // stop. The point is that it is REFUSED OUT LOUD — silently dropping it
    // leaves the same "i don't see images" with no explanation.
    const load = vi.fn(async () => 'data:image/png;base64,CCC');

    await render('![tracker](https://example.com/pixel.png)', load);

    expect(load).not.toHaveBeenCalled();
    expect(src()).toBeNull();
    expect(unavailable()).toContain('remote images are not loaded');
    // …naming the reference, so the user can see what was skipped.
    expect(unavailable()).toContain('https://example.com/pixel.png');
  });

  it('shows the path when the daemon cannot read it', async () => {
    // "could not read /tmp/shots/x.png" is a fact the user can act on. A
    // broken-image box is the bug being reported a second time.
    const load = vi.fn(async () => {
      throw new Error('no file at /tmp/shots/gone.png');
    });

    await render('![gone](/tmp/shots/gone.png)', load);

    expect(src()).toBeNull();
    expect(unavailable()).toContain('/tmp/shots/gone.png');
  });

  it('renders a data: URL without going near the loader', async () => {
    // The one scheme the CSP already allows, and what every fetched reference
    // is turned INTO — so a round trip for it would be pure cost.
    const load = vi.fn(async () => 'data:image/png;base64,NOPE');

    await render('![dot](data:image/gif;base64,R0lGOD)', load);

    expect(load).not.toHaveBeenCalled();
    expect(src()).toBe('data:image/gif;base64,R0lGOD');
  });

  it('falls back to the reference itself with no loader in context', async () => {
    // Outside a provider — a transcript rendered somewhere with no run behind
    // it. It must not throw, and it must not draw a broken box.
    await render('![chart](a.png)', null);

    expect(src()).toBeNull();
    expect(container.textContent).toContain('chart');
  });
});
