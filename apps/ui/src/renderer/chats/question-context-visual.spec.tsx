// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stubResizeObserver } from '../__tests__/stub-resize-observer';
import { QuestionContextVisual } from './question-context-visual';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

stubResizeObserver();

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

function draw(
  entry: Parameters<typeof QuestionContextVisual>[0]['entry'],
): void {
  act(() => {
    root.render(<QuestionContextVisual entry={entry} />);
  });
}

describe('QuestionContextVisual', () => {
  it('draws a page the thread published as its artifact card, open', () => {
    draw({
      seq: 3,
      artifact: {
        artifactId: 'pr-673-acceptance',
        version: 1,
        title: 'PR #673 — acceptance',
        summary: null,
        key: 'a'.repeat(64),
      },
    });

    const card = container.querySelector('[data-slot="artifact-card"]');
    expect(card?.getAttribute('data-open')).toBe('true');
    expect(container.textContent).toContain('PR #673 — acceptance');
  });

  it('draws the pictures the thread handed over as its gallery card', () => {
    draw({
      seq: 4,
      gallery: {
        title: 'Strip screenshots',
        images: [
          {
            path: 'shots/strip.png',
            caption: null,
            description: null,
            source: null,
          },
        ],
      },
    });

    expect(
      container.querySelector('[data-slot="gallery-card"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Strip screenshots');
  });
});
