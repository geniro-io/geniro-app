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

  it('lets a MESSAGE use the whole column, and still bounds it', () => {
    // Both halves, because each without the other is a defect that shipped.
    //
    // The FRACTION is gone: capped at 76% and `self-start`, every agent row sat
    // in the left three-quarters of the pane with the last quarter empty —
    // REPORTED as the transcript's wrong content width, "previously it was
    // capped, so all messages were on the left". `max-w-[…%]` rather than a
    // looser fraction, because no fraction is right: the pane doubles in width
    // when the side columns fold away, so the dead space grows with the window.
    //
    // A CAP remains, which is what the previous version of this test was
    // guarding and the reason it is edited rather than deleted: min-w-0 only
    // lets a max-width win, and with none at all an unbreakable token (a pasted
    // URL) sizes the bubble past the column, where the scroller's
    // `overflow-x-hidden` clips it — the same "text is outside block" report,
    // reopened from the other side. 100% is the whole column and not a pixel
    // more.
    for (const variant of [
      'user',
      'assistant',
      'reasoning',
      'error',
    ] as const) {
      render(<MessageBubble variant={variant}>body</MessageBubble>);
      expect(bubble()?.className, variant).toContain('max-w-full');
      expect(bubble()?.className, variant).not.toMatch(/max-w-\[\d+%\]/);
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it('keeps the NOTE capped, which is what makes it read as centred', () => {
    // The one variant that is not a message. `self-center` centres the box, so
    // a note allowed the full width is a block touching both edges and the
    // centring stops being visible at all — the "this message should be in
    // center" report, which the cap above answers. Pinned separately so the
    // change that freed the messages cannot quietly take this with it.
    render(<MessageBubble variant="note">body</MessageBubble>);
    expect(bubble()?.className).toContain('max-w-[76%]');
    expect(bubble()?.className).toContain('self-center');
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
