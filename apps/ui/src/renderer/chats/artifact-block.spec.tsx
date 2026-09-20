// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
        value={(a) => `http://127.0.0.1:1/a?v=${a.version}`}>
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
