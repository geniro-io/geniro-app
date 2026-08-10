// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { type BubbleVariant, MessageBubble } from './message-bubble';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const bubble = (): HTMLElement | null =>
  container?.querySelector('[data-role]') ?? null;

const ALL_VARIANTS: BubbleVariant[] = [
  'user',
  'assistant',
  'reasoning',
  'tool',
  'call',
  'error',
  'note',
];

describe('MessageBubble', () => {
  it('can shrink below its content — every variant carries min-w-0', () => {
    // The bubble is a flex ITEM of the transcript column, so without min-w-0
    // its min-width resolves to the content's min-content width — and CSS
    // applies min-width ABOVE max-width. A single unbreakable token (a pasted
    // URL) then pushed the bubble past its own max-w-[76%] and out of the
    // column, which is the reported "text is outside block".
    //
    // Asserted for EVERY variant, not just `user`: the fix lives in the shared
    // cva base, and a later variant-level rewrite that drops it would otherwise
    // regress only the variant nobody sampled. jsdom has no layout engine, so
    // the class the component renders is the observable available here — the
    // same standard markdown-content.spec.tsx holds itself to.
    for (const variant of ALL_VARIANTS) {
      render(<MessageBubble variant={variant}>body</MessageBubble>);
      expect(bubble()?.className, variant).toContain('min-w-0');
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it('keeps the width cap that min-w-0 exists to make reachable', () => {
    // min-w-0 alone is not the fix — it only lets max-w-[76%] win. Pinned so a
    // future "let bubbles be full width" change has to face this pairing
    // rather than silently re-opening the overflow from the other side.
    render(<MessageBubble variant="user">body</MessageBubble>);
    expect(bubble()?.className).toContain('max-w-[76%]');
  });

  it('renders the role caption only when one is given', () => {
    render(<MessageBubble variant="assistant">body</MessageBubble>);
    expect(container?.textContent).toBe('body');

    act(() => root?.unmount());
    container?.remove();

    render(
      <MessageBubble variant="assistant" role="thinking">
        body
      </MessageBubble>,
    );
    expect(container?.textContent).toContain('thinking');
  });
});
