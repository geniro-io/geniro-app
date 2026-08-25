// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  THINKING_MAX_HEIGHT_PX,
  ThinkingDisclosure,
  ThinkingScroller,
} from './thinking-block';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom implements no element scrolling at all — `Element.prototype.scrollTo`
 * does not exist — and lays nothing out, so a scroll container's geometry
 * reads 0 in every dimension. Both are supplied here, the same way
 * `Chats.spec.tsx` supplies them for the transcript's own auto-scroll: what is
 * under test is WHICH call the component makes and when, never the browser's
 * scrolling.
 */
const scrollTo = vi.fn();
Element.prototype.scrollTo = scrollTo;

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

function rerender(element: React.ReactElement): void {
  act(() => {
    root!.render(element);
  });
}

beforeEach(() => {
  scrollTo.mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function fakeGeometry(
  box: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(box, key, { value, configurable: true });
  }
}

function scroller(el: HTMLElement): HTMLElement {
  const box = el.querySelector<HTMLElement>('[data-slot="thinking-scroller"]');
  if (box === null) {
    throw new Error('no thinking scroller rendered');
  }
  return box;
}

const LONG = `${'The agent reasons at length. '.repeat(40)}`;

describe('ThinkingScroller', () => {
  it('bounds the stretch at the reported height and scrolls inside itself', () => {
    // REPORTED as "этот thinking-блок у курсора очень большой… должно иметь
    // какую-то максимальную высоту, например 300 px". Asserted on the emitted
    // style and class rather than on computed layout: jsdom loads no
    // stylesheet and lays nothing out, so `getComputedStyle` would report the
    // default here and pass with the cap deleted.
    const el = render(<ThinkingScroller text={LONG} />);
    const box = scroller(el);

    expect(box.style.maxHeight).toBe(`${THINKING_MAX_HEIGHT_PX}px`);
    expect(box.className).toContain('overflow-y-auto');
  });

  it('follows the newest words as the stretch grows', () => {
    // The other half of the ask — "он просто всё время scrollit вверх сам и
    // показывает самое последнее". A fixed box that did NOT follow would show
    // the paragraph the agent wrote a minute ago, motionless under a spinner.
    const el = render(<ThinkingScroller text="first" />);
    const box = scroller(el);
    fakeGeometry(box, {
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 300,
    });

    rerender(<ThinkingScroller text="first second" />);

    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' });
  });

  it('stops following once the reader scrolls UP, and re-arms at the bottom', () => {
    // The transcript's own rule, and the reason it is that rule: content that
    // grows pushes the bottom away without the reader touching anything, so
    // "am I at the bottom" alone would switch the follow off during the very
    // streaming it exists for. Only a scroll that moved the viewport up counts.
    const el = render(<ThinkingScroller text="a" />);
    const box = scroller(el);
    fakeGeometry(box, {
      scrollTop: 600,
      scrollHeight: 900,
      clientHeight: 300,
    });

    // Land at the bottom first, so `lastTop` is a real position to move up from.
    rerender(<ThinkingScroller text="a b" />);
    scrollTo.mockClear();

    // The reader drags upward.
    Object.defineProperty(box, 'scrollTop', { value: 100, configurable: true });
    act(() => {
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    rerender(<ThinkingScroller text="a b c" />);
    expect(scrollTo).not.toHaveBeenCalled();

    // …and back down to the end, which re-arms it.
    Object.defineProperty(box, 'scrollTop', { value: 600, configurable: true });
    act(() => {
      box.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    rerender(<ThinkingScroller text="a b c d" />);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' });
  });
});

describe('ThinkingDisclosure', () => {
  it('folds a finished stretch behind its first line, and opens on a press', () => {
    // REPORTED as "потом это должно быть collapsed, как только он закончил
    // thinking… потом мы его можем развернуть".
    const text = `What the agent was thinking about\n${LONG}`;
    const el = render(
      <ThinkingDisclosure text={text}>
        <p data-testid="body">{text}</p>
      </ThinkingDisclosure>,
    );

    expect(el.querySelector('[data-testid="body"]')).toBeNull();
    const trigger = el.querySelector('button')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('What the agent was thinking about');

    act(() => {
      trigger.click();
    });

    expect(el.querySelector('[data-testid="body"]')).not.toBeNull();
    expect(el.querySelector('button')!.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('previews the first line with anything ON it', () => {
    // A chain of thought routinely opens with a blank line, and a preview of
    // that shows the reader nothing they can decide on.
    const el = render(
      <ThinkingDisclosure text={`\n\n   \nThe real opening line.\n${LONG}`}>
        <p>body</p>
      </ThinkingDisclosure>,
    );

    expect(el.querySelector('button')!.textContent).toContain(
      'The real opening line.',
    );
  });

  it('leaves a SHORT stretch alone — no fold, no control', () => {
    // Folding two sentences into a one-line preview plus a chevron hides
    // nothing worth hiding and charges a click for it.
    const el = render(
      <ThinkingDisclosure text="One brief thought.">
        <p data-testid="body">One brief thought.</p>
      </ThinkingDisclosure>,
    );

    expect(el.querySelector('[data-testid="body"]')).not.toBeNull();
    expect(el.querySelector('button')).toBeNull();
  });
});
