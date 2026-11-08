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

function render(
  onFiles: (files: File[]) => void,
  disabled = false,
): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<AttachFilesButton onFiles={onFiles} disabled={disabled} />);
  });
  return container;
}

describe('AttachFilesButton', () => {
  it('is the file input itself, so a press reaches it with no scripted click', () => {
    const host = render(() => {});
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Attach files or images"]',
    )!;

    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.hidden).toBe(false);
    expect(input.className).toContain('absolute inset-0 size-full');
    expect(input.className).toContain('opacity-0');
    expect(host.querySelector('button')).toBeNull();
  });

  it('refuses the press while the composer is disabled', () => {
    const host = render(() => {}, true);

    expect(
      host.querySelector<HTMLInputElement>(
        '[data-slot="composer-attach-input"]',
      )!.disabled,
    ).toBe(true);
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
