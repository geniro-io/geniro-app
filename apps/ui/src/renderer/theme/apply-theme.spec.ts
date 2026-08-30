// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initTheme, setThemePreference } from './apply-theme';

/**
 * jsdom ships no `matchMedia`, and this module is the one place the app reads
 * it — so the stub IS the OS appearance for these tests, and flipping it is how
 * a system-appearance change is driven.
 */
function stubMatchMedia(): {
  setDark: (dark: boolean) => void;
  listenerCount: () => number;
} {
  let dark = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return dark;
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
    setDark: (next: boolean) => {
      dark = next;
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

describe('apply-theme', () => {
  let media: ReturnType<typeof stubMatchMedia>;

  beforeEach(() => {
    // The stub goes in FIRST: the module holds its state across tests, so
    // resetting the preference below already reads the media query.
    media = stubMatchMedia();
    delete document.documentElement.dataset.theme;
    setThemePreference('system');
  });

  it('writes data-theme on <html>, which is what every token selector keys on', () => {
    initTheme();

    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the OS while the preference is System', () => {
    initTheme();

    media.setDark(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    media.setDark(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  // The store's SUBSCRIBER path is not asserted here: it has no observable at
  // this level that "follows the OS" above does not already pin, and reaching
  // it would mean exporting `subscribe` for the test alone. It is covered
  // where it is actually observable — `md-editor.spec.tsx` mounts a component,
  // changes the theme, and asserts the DOM followed without a remount.

  it('lets an explicit preference override the OS', () => {
    initTheme();
    media.setDark(true);
    expect(document.documentElement.dataset.theme).toBe('dark');

    setThemePreference('light');

    // In the real app main also writes `themeSource`, which moves the media
    // query to match; the stub deliberately does not, so this asserts the
    // renderer's own resolution rather than the stub's.
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
