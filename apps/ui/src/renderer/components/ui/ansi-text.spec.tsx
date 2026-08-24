// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { AnsiText } from './ansi-text';

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
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

const ESC = '\u001b';

describe('AnsiText', () => {
  it('draws a coloured run in that colour’s TOKEN class', () => {
    // The colour comes from the palette, never from the stream: a terminal's
    // own green is built for a black background.
    const el = render(<AnsiText text={`${ESC}[32mPASS${ESC}[0m 42 tests`} />);

    const span = el.querySelector('[data-ansi-color="green"]')!;
    expect(span.textContent).toBe('PASS');
    expect(span.className).toContain('text-ansi-green');
    // …and no colour literal reaches the DOM.
    expect(el.innerHTML).not.toContain('#');
  });

  it('carries weight, dimming, italics and underline', () => {
    const el = render(<AnsiText text={`${ESC}[1;2;3;4mstyled`} />);

    const span = el.querySelector('[data-slot="ansi-span"]')!;
    expect(span.className).toContain('font-bold');
    expect(span.className).toContain('opacity-60');
    expect(span.className).toContain('italic');
    expect(span.className).toContain('underline');
  });

  it('renders the whole text, codes removed', () => {
    // The reader's own check: whatever the styling, the characters are all
    // there and none of the escape sequences are.
    const el = render(
      <AnsiText text={`${ESC}[31merror${ESC}[0m: ${ESC}[2Kbuilding`} />,
    );

    expect(el.textContent).toBe('error: building');
  });

  it('spends no element on uncoloured output', () => {
    // Most of a log carries no colour at all, and a span per run of it would
    // be a DOM the size of the file.
    const el = render(<AnsiText text={'plain output\nsecond line\n'} />);

    expect(el.querySelector('[data-slot="ansi-span"]')).toBeNull();
    expect(el.textContent).toBe('plain output\nsecond line\n');
  });
});
