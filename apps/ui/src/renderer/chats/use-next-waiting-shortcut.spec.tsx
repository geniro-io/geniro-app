// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNextWaitingShortcut } from './use-next-waiting-shortcut';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Harness({ onJump }: { onJump: () => void }): React.JSX.Element {
  useNextWaitingShortcut(onJump);
  return (
    <>
      <textarea aria-label="Composer" />
      <span data-slot="inline-rename">
        <input aria-label="Rename" />
      </span>
      <div role="dialog" aria-modal="true">
        <input aria-label="Dialog field" />
      </div>
    </>
  );
}

async function mount(onJump: () => void): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness onJump={onJump} />);
  });
  return container;
}

function press(
  target: Element,
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

describe('useNextWaitingShortcut', () => {
  it('jumps on ⌘J before a focused field can take the chord', async () => {
    const onJump = vi.fn();
    const view = await mount(onJump);

    const { event, reachedTarget } = press(view.querySelector('textarea')!, {
      metaKey: true,
      code: 'KeyJ',
      key: 'j',
    });

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedTarget).toBe(false);
  });

  it('ignores the same key with another modifier, or none', async () => {
    const onJump = vi.fn();
    const view = await mount(onJump);
    const input = view.querySelector('textarea')!;

    press(input, { metaKey: true, shiftKey: true, code: 'KeyJ' });
    press(input, { metaKey: true, altKey: true, code: 'KeyJ' });
    press(input, { metaKey: true, ctrlKey: true, code: 'KeyJ' });
    press(input, { code: 'KeyJ', key: 'j' });

    expect(onJump).not.toHaveBeenCalled();
  });

  it('lets every other ⌘ chord through to the field untouched', async () => {
    const onJump = vi.fn();
    const view = await mount(onJump);

    const { event, reachedTarget } = press(view.querySelector('textarea')!, {
      metaKey: true,
      code: 'KeyK',
      key: 'k',
    });

    expect(onJump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedTarget).toBe(true);
  });

  it('leaves the chord alone while a name is being typed in place', async () => {
    const onJump = vi.fn();
    const view = await mount(onJump);

    press(view.querySelector('[aria-label="Rename"]')!, {
      metaKey: true,
      code: 'KeyJ',
    });

    expect(onJump).not.toHaveBeenCalled();
  });

  it('leaves the chord alone inside a modal dialog, which would be left over a changed screen', async () => {
    const onJump = vi.fn();
    const view = await mount(onJump);

    const { event } = press(
      view.querySelector('[aria-label="Dialog field"]')!,
      {
        metaKey: true,
        code: 'KeyJ',
      },
    );

    expect(onJump).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
