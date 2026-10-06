// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AttachFilesButton } from './attach-files-button';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function render(onFiles: (files: File[]) => void): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<AttachFilesButton onFiles={onFiles} />);
  });
  return container;
}

describe('AttachFilesButton', () => {
  it('opens the browser’s own picker, which a phone can use too', () => {
    const host = render(() => {});
    const input = host.querySelector<HTMLInputElement>(
      '[data-slot="composer-attach-input"]',
    )!;
    const click = vi.spyOn(input, 'click');

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Attach files or images"]',
        )!
        .click();
    });

    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('hands over what was picked and clears the input for the same file again', () => {
    const onFiles = vi.fn();
    const host = render(onFiles);
    const input = host.querySelector<HTMLInputElement>(
      '[data-slot="composer-attach-input"]',
    )!;
    const picked = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    Object.defineProperty(input, 'files', {
      value: [picked],
      configurable: true,
    });

    act(() => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onFiles).toHaveBeenCalledWith([picked]);
    expect(input.value).toBe('');
  });
});
