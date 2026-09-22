// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ArtifactCard } from './artifact-block';
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
  latest = true,
): Promise<void> {
  await act(async () => {
    root.render(
      <ArtifactUrlContext.Provider
        // Mirrors `artifactPageUrl`'s own contract, including the raw flag —
        // a provider that ignored the option would let a test assert `raw=1`
        // against a string the test itself wrote. The real builder is pinned
        // in `published-artifact.spec.ts`.
        value={(a, options) =>
          `http://127.0.0.1:1/a?v=${a.version}${options?.raw === true ? '&raw=1' : ''}`
        }>
        <ArtifactCard artifact={artifact} latest={latest} />
      </ArtifactUrlContext.Provider>,
    );
  });
}

/** The card's own frame; the dialog's is portalled onto the document. */
const inlineFrame = (): HTMLIFrameElement | null =>
  container.querySelector('iframe');

const button = (label: RegExp): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) =>
    label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  );
  if (!found) {
    throw new Error(`no button matching ${String(label)}`);
  }
  return found;
};

/**
 * The save path stubbed at both of its ends — the fetch that reads the page,
 * and the preload channel that would open a native panel.
 */
function stubSaving(html = '<html><head></head><body>p</body></html>'): {
  saveArtifact: ReturnType<typeof vi.fn>;
  fetched: string[];
} {
  const fetched: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetched.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(html),
      });
    }),
  );
  const saveArtifact = vi.fn(() =>
    Promise.resolve({ saved: false, path: null }),
  );
  vi.stubGlobal('geniro', { saveArtifact });
  return { saveArtifact, fetched };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ArtifactCard — saving the page as a file', () => {
  it('fetches the RAW document and hands it to the save channel', async () => {
    // The wrapper is a postMessage handshake with an embedder, so a file the
    // user sends to somebody must not carry it.
    const { saveArtifact, fetched } = stubSaving();
    await render();

    await act(async () => {
      button(/Save .* as an HTML file/).click();
    });

    expect(fetched[0]).toContain('raw=1');
    expect(saveArtifact).toHaveBeenCalledTimes(1);
    const sent = saveArtifact.mock.calls[0]![0] as {
      suggestedName: string;
      html: string;
    };
    expect(sent.suggestedName).toBe('Migration-plan');
    expect(sent.html).toContain('<body>p</body>');
  });

  it('bakes the theme into what it sends, so the file needs no host', async () => {
    document.documentElement.style.setProperty('--foreground', 'sentinel-ink');
    const { saveArtifact } = stubSaving();
    await render();

    await act(async () => {
      button(/Save .* as an HTML file/).click();
    });

    const sent = saveArtifact.mock.calls[0]![0] as { html: string };
    expect(sent.html).toContain('--geniro-fg: sentinel-ink;');
  });

  it('says so when the page could not be read', async () => {
    // A refusal written to disk under the plan's own name would be a file
    // containing the words "not found".
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve('no'),
        }),
      ),
    );
    vi.stubGlobal('geniro', { saveArtifact: vi.fn() });
    await render();

    await act(async () => {
      button(/Save .* as an HTML file/).click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
      /404/,
    );
  });

  it('draws NO save control when the page cannot be addressed', async () => {
    // Same rule the frame follows: without a URL builder there is nothing to
    // fetch, so a button here would be a press that does nothing.
    await act(async () => {
      root.render(<ArtifactCard artifact={ARTIFACT} latest />);
    });

    expect(
      [...container.querySelectorAll('button')].some((b) =>
        /Save/.test(b.getAttribute('aria-label') ?? ''),
      ),
    ).toBe(false);
  });
});

describe('ArtifactCard', () => {
  it('names the page', async () => {
    await render();
    expect(container.textContent).toContain('Migration plan');
  });

  it('shows the page INLINE rather than behind a link', async () => {
    // The gallery card's reasoning: the agent produced this to be looked at,
    // and a card that only names it charges a click to see whether it was
    // worth one.
    await render();
    expect(inlineFrame()?.getAttribute('src')).toBe('http://127.0.0.1:1/a?v=1');
  });

  it('drops the frame when the reader folds the card', async () => {
    // Not merely hidden — an open frame is a live sandboxed document.
    await render();
    expect(inlineFrame()).not.toBeNull();

    await act(async () => {
      button(/Migration plan/).click();
    });

    expect(inlineFrame()).toBeNull();
  });

  it('starts FOLDED when a later version has superseded it', async () => {
    // Every publish keeps its card, so a plan revised ten times would hold ten
    // live documents at once if each opened itself.
    await render(ARTIFACT, false);
    expect(inlineFrame()).toBeNull();
  });

  it('lets the reader open a superseded card anyway', async () => {
    await render(ARTIFACT, false);

    await act(async () => {
      button(/Migration plan/).click();
    });

    expect(inlineFrame()).not.toBeNull();
  });

  it('puts its controls on the FRAME while the card is open', async () => {
    // REPORTED as "i wanna move icons for open and download artifact to
    // border, now they have a lot of margin from bottom" — on the heading they
    // sat a summary line and two margins above the page they act on. Pinned as
    // "do the buttons share a box with the iframe", which is what being on the
    // frame's corner MEANS; jsdom computes no layout, so the position itself
    // is unobservable here and the containment is the fact that decides it.
    await render();
    const frame = inlineFrame();
    expect(frame).not.toBeNull();

    for (const label of [/Save .* as an HTML file/, /full screen/i]) {
      expect(button(label).closest('div')?.contains(frame!)).toBe(true);
    }
  });

  it('gives them back to the heading when the card is folded', async () => {
    // A folded card has no frame, and a control that vanished with the page
    // would leave a reader who folded a long artifact unable to save it
    // without unfolding it again.
    await render(ARTIFACT, false);
    expect(inlineFrame()).toBeNull();

    expect(button(/Save .* as an HTML file/).closest('p')).not.toBeNull();
    expect(button(/full screen/i).closest('p')).not.toBeNull();
  });

  it('states the version only once there is more than one', async () => {
    await render({ ...ARTIFACT, version: 1 });
    expect(container.textContent).not.toContain('v1');

    await render({ ...ARTIFACT, version: 3 });
    expect(container.textContent).toContain('v3');
  });

  it('shows the summary when the agent wrote one, and nothing when it did not', async () => {
    await render({ ...ARTIFACT, summary: null });
    expect(container.textContent).toContain('Migration plan');

    await render({ ...ARTIFACT, summary: 'three phases' });
    expect(container.textContent).toContain('three phases');
  });

  it('opens the same page full-screen', async () => {
    await render();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      button(/full screen/i).click();
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('iframe')?.getAttribute('src')).toBe(
      'http://127.0.0.1:1/a?v=1',
    );
  });

  it('closes the popup again', async () => {
    await render();
    await act(async () => {
      button(/full screen/i).click();
    });
    const close = document.body.querySelector<HTMLButtonElement>(
      '[role="dialog"] [aria-label="Close"]',
    );
    expect(close).not.toBeNull();

    await act(async () => {
      close!.click();
    });

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
