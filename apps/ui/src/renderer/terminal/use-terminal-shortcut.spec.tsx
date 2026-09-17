// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTerminalShortcut } from './use-terminal-shortcut';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Harness({ onToggle }: { onToggle: () => void }): React.JSX.Element {
  useTerminalShortcut(onToggle);
  return <textarea aria-label="Terminal input" />;
}

async function mount(onToggle: () => void): Promise<HTMLTextAreaElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness onToggle={onToggle} />);
  });
  return container.querySelector('textarea')!;
}

function press(
  target: HTMLElement,
  init: KeyboardEventInit,
): { event: KeyboardEvent; reachedTarget: boolean } {
  let reachedTarget = false;
  const listener = (): void => {
    reachedTarget = true;
  };
  target.addEventListener('keydown', listener);
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  target.removeEventListener('keydown', listener);
  return { event, reachedTarget };
}

describe('useTerminalShortcut', () => {
  it('toggles on ⌃` before a focused terminal can take the chord', async () => {
    const onToggle = vi.fn();
    const input = await mount(onToggle);

    const { event, reachedTarget } = press(input, {
      ctrlKey: true,
      code: 'Backquote',
    });

    expect(onToggle).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    // The emulator's own keydown handler sits on the focused element; reaching
    // it would send the shell a NUL.
    expect(reachedTarget).toBe(false);
  });

  it('leaves every other chord on the key alone', async () => {
    const onToggle = vi.fn();
    const input = await mount(onToggle);

    for (const init of [
      { code: 'Backquote' },
      { ctrlKey: true, metaKey: true, code: 'Backquote' },
      { ctrlKey: true, altKey: true, code: 'Backquote' },
      { ctrlKey: true, code: 'KeyL' },
    ]) {
      expect(press(input, init).reachedTarget).toBe(true);
    }
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('stops listening once unmounted', async () => {
    const onToggle = vi.fn();
    const input = await mount(onToggle);
    act(() => root!.unmount());
    root = null;

    press(input, { ctrlKey: true, code: 'Backquote' });

    expect(onToggle).not.toHaveBeenCalled();
  });
});
