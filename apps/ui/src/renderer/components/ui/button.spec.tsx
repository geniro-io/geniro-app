// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from './button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('Button', () => {
  // `aria-disabled` rather than `disabled` is how a button stays hoverable so
  // the sentence saying WHY it is withheld can be read — and it has to look
  // withheld too, or it reads as live and does nothing when pressed. The base
  // carries the dimming, so this is the one place it can regress.
  it('looks withheld when aria-disabled, like a disabled one does', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Button aria-disabled>Send</Button>);
    });
    const button = container.querySelector('button')!;
    expect(button.className).toContain('aria-disabled:opacity-50');
    expect(button.className).toContain('aria-disabled:cursor-not-allowed');
  });

  it('does not fill a withheld ghost button on hover', () => {
    // A ghost button is drawn only by its hover fill, so a withheld one that
    // still filled looked pressable — and a phone has no tooltip to say why.
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <Button variant="ghost" aria-disabled>
          Edit
        </Button>,
      );
    });
    expect(container.querySelector('button')!.className).toContain(
      'aria-disabled:hover:bg-transparent',
    );
  });
});
