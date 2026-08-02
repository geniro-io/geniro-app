// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CopyButton } from './copy-button';
import { CodeBlock } from './ui/code-block';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(el: React.ReactNode): void {
  act(() => root.render(el));
}

function click(button: Element): void {
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('CopyButton', () => {
  it('writes the exact text it was given to the clipboard', async () => {
    // Braces, not a quoted attribute: JSX does not process escapes in a
    // string literal attribute, so `text="a\nb"` would pass a literal
    // backslash-n and the assertion would be testing the wrong string.
    render(<CopyButton text={'  indented\nline'} />);
    click(container.querySelector('button')!);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('  indented\nline');
  });

  it('acknowledges only after the write actually resolves', async () => {
    let settle: (() => void) | undefined;
    writeText.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    render(<CopyButton text="x" />);
    const button = container.querySelector('button')!;
    click(button);
    await act(async () => {});
    // In flight: the ✓ must not be showing yet — a button that claims success
    // before the clipboard accepted it is lying to the user.
    expect(button.querySelector('.text-success')).toBeNull();
    await act(async () => {
      settle?.();
    });
    expect(button.querySelector('.text-success')).not.toBeNull();
  });

  it('says it failed rather than showing a ✓ when the clipboard rejects', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('denied')));
    render(<CopyButton text="x" />);
    const button = container.querySelector('button')!;
    click(button);
    await act(async () => {});
    expect(button.querySelector('.text-success')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('Copy failed');
  });
});

describe('CodeBlock copy affordance', () => {
  it('copies the RAW source, not the highlighted markup', async () => {
    // The highlighter turns this into a tree of <span>s; reading the DOM back
    // would be a different string the moment a gutter or ellipsis is added.
    const source = 'const a = 1;\nconst b = 2;';
    render(<CodeBlock code={source} language="ts" />);
    // Sanity: highlighting really did run, so the assertion below is not
    // passing merely because the block rendered as plain text.
    expect(container.querySelectorAll('pre span').length).toBeGreaterThan(0);

    click(container.querySelector('button[aria-label="Copy code"]')!);
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(source);
  });
});
