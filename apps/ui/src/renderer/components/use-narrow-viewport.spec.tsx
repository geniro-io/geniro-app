// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useNarrowViewport } from './use-narrow-viewport';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom ships no `matchMedia` — see `theme/apply-theme.spec.ts`'s identical
 * stub. Here the stub IS the viewport width for these tests: flipping it is
 * how a resize (or the LAN gateway opening on a phone from the start) is
 * driven.
 */
function stubMatchMedia(): {
  setNarrow: (narrow: boolean) => void;
  listenerCount: () => number;
} {
  let narrow = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return narrow;
      },
      addEventListener: (_: string, listener: () => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_: string, listener: () => void) => {
        listeners.delete(listener);
      },
    })),
  );
  return {
    setNarrow: (next: boolean) => {
      narrow = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

/** A probe that renders the hook's answer, not its internals. */
function Probe(): React.JSX.Element {
  const narrow = useNarrowViewport();
  return <span>{narrow ? 'narrow' : 'wide'}</span>;
}

async function mount(): Promise<HTMLSpanElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Probe />);
  });
  return container.querySelector('span')!;
}

describe('useNarrowViewport', () => {
  it('reads the media query on mount', async () => {
    const media = stubMatchMedia();
    media.setNarrow(true);

    const span = await mount();

    expect(span.textContent).toBe('narrow');
  });

  it('follows a later change — a window resize, or a phone opening the LAN gateway', async () => {
    const media = stubMatchMedia();

    const span = await mount();
    expect(span.textContent).toBe('wide');

    await act(async () => {
      media.setNarrow(true);
    });

    expect(span.textContent).toBe('narrow');
  });

  it('unsubscribes on unmount, or every remount leaks another listener', async () => {
    const media = stubMatchMedia();
    await mount();

    expect(media.listenerCount()).toBe(1);

    act(() => {
      root!.unmount();
    });

    expect(media.listenerCount()).toBe(0);
  });

  it('answers "wide" rather than throwing when matchMedia is absent — jsdom\'s own default, and every OTHER spec that happens to mount a component using this hook', async () => {
    // No `stubMatchMedia()` here: this is what every spec in this codebase
    // gets by default, since jsdom ships no `matchMedia` at all. A caller
    // that renders `Chats` (or anything else built on this hook) to test
    // something unrelated must not have to know this hook exists, let alone
    // stub a global for it — this is the branch that guarantees that.
    expect(window.matchMedia).toBeUndefined();

    const span = await mount();

    expect(span.textContent).toBe('wide');
  });
});
