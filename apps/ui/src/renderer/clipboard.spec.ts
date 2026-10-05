// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeClipboard } from './clipboard';

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  setClipboard(undefined);
  vi.restoreAllMocks();
});

describe('writeClipboard', () => {
  it('uses the Clipboard API where the page has one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });

    await writeClipboard('hello');

    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('copies through the page itself where it has none — the phone’s plain-http LAN page', async () => {
    setClipboard(undefined);
    let copied: string | null = null;
    const exec = vi.fn((command: string) => {
      // What `copy` takes is the SELECTION, not the field's whole value.
      const area = document.querySelector('textarea');
      copied =
        command === 'copy' && area
          ? area.value.slice(area.selectionStart, area.selectionEnd)
          : null;
      return true;
    });
    document.execCommand = exec;

    await writeClipboard('  indented\nline');

    expect(exec).toHaveBeenCalledWith('copy');
    expect(copied).toBe('  indented\nline');
    // Nothing left behind in the page.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('gives focus back to what had it, so the copy does not move the reader', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => true);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    await writeClipboard('x');

    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('reports a refused copy as a failure, so the button can say so', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);

    await expect(writeClipboard('x')).rejects.toThrow('refused');
    expect(document.querySelector('textarea')).toBeNull();
  });
});
