import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyTheme,
  resolvedTheme,
  watchSystemAppearance,
} from './native-appearance';

/**
 * The stub emits `updated` on every `themeSource` ASSIGNMENT, because the real
 * `nativeTheme` does (electron.d.ts lists it under the effects of setting the
 * property). A plain data property here would make the re-entrancy guard in
 * `watchSystemAppearance` untestable — and did: the guard's own test passed
 * against a handler rewritten to feed itself.
 */
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, () => void>();
  const setBackgroundColor = vi.fn();
  let source: 'system' | 'light' | 'dark' = 'system';
  return {
    listeners,
    setBackgroundColor,
    emitUpdated: () => listeners.get('updated')?.(),
    nativeTheme: {
      get themeSource() {
        return source;
      },
      set themeSource(next: 'system' | 'light' | 'dark') {
        source = next;
        listeners.get('updated')?.();
      },
      shouldUseDarkColors: false,
      on: (event: string, listener: () => void) => {
        listeners.set(event, listener);
      },
    },
    windows: [{ setBackgroundColor }],
  };
});

vi.mock('electron', () => ({
  nativeTheme: mocks.nativeTheme,
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

beforeEach(() => {
  mocks.listeners.clear();
  mocks.nativeTheme.themeSource = 'system';
  mocks.nativeTheme.shouldUseDarkColors = false;
  mocks.setBackgroundColor.mockClear();
});

describe('applyTheme', () => {
  it('declares an explicit theme to the OS, so macOS stops drawing its chrome for the other one', () => {
    // The original defect in one assertion, and it now runs in both
    // directions: left at 'system', a machine whose appearance disagrees with
    // the app's palette tints the inactive traffic lights to match the OS and
    // they disappear into this app's own title bar.
    expect(applyTheme('dark')).toBe('dark');
    expect(mocks.nativeTheme.themeSource).toBe('dark');

    expect(applyTheme('light')).toBe('light');
    expect(mocks.nativeTheme.themeSource).toBe('light');
  });

  it('hands System back to the OS and resolves from what the OS then reports', () => {
    mocks.nativeTheme.shouldUseDarkColors = true;

    expect(applyTheme('system')).toBe('dark');
    expect(mocks.nativeTheme.themeSource).toBe('system');
  });

  it('ignores the OS under an explicit pick — an override the OS could veto is not one', () => {
    mocks.nativeTheme.shouldUseDarkColors = true;

    // The stub deliberately leaves `shouldUseDarkColors` alone, which is what
    // makes this assert the resolution rather than the stub.
    expect(applyTheme('light')).toBe('light');
  });

  it("repaints an open window's own ground, which is a construction option nothing else re-reads", () => {
    // Without this the window keeps the theme it was CREATED under for the life
    // of the process, and the strip macOS exposes during a resize flashes the
    // other palette.
    applyTheme('dark');

    expect(mocks.setBackgroundColor).toHaveBeenCalledWith('#171615');
  });

  it('paints the light ground when the pick goes the other way', () => {
    applyTheme('light');

    expect(mocks.setBackgroundColor).toHaveBeenCalledWith('#f5f1eb');
  });
});

describe('resolvedTheme', () => {
  it('answers without touching the OS, for a window that does not exist yet', () => {
    mocks.nativeTheme.shouldUseDarkColors = true;
    mocks.nativeTheme.themeSource = 'system';
    mocks.setBackgroundColor.mockClear();

    expect(resolvedTheme('system')).toBe('dark');
    expect(resolvedTheme('light')).toBe('light');
    // A write here would emit `updated`, and a paint would be a no-op that hid
    // a missing one in `applyTheme`.
    expect(mocks.nativeTheme.themeSource).toBe('system');
    expect(mocks.setBackgroundColor).not.toHaveBeenCalled();
  });
});

describe('watchSystemAppearance', () => {
  it('repaints when the OS appearance flips under System — the one change no settings write reports', () => {
    watchSystemAppearance(() => 'system');
    mocks.setBackgroundColor.mockClear();

    mocks.nativeTheme.shouldUseDarkColors = true;
    mocks.emitUpdated();

    expect(mocks.setBackgroundColor).toHaveBeenCalledWith('#171615');
  });

  it('does not re-enter itself when the app writes themeSource', () => {
    // The stub emits `updated` on assignment exactly as Electron does, so a
    // handler that called `applyTheme` would recurse. Counting entries is what
    // discriminates: asserting the resulting `themeSource` does not, because a
    // self-feeding handler produces the same value.
    let entries = 0;
    watchSystemAppearance(() => {
      entries += 1;
      return 'system';
    });

    applyTheme('system');

    expect(entries).toBe(1);
  });

  it('ignores its own writes under an explicit preference, where the paint is a no-op', () => {
    // Electron emits `updated` for an assignment too, so without the guard this
    // handler pays a synchronous settings read on the launch path.
    let reads = 0;
    watchSystemAppearance(() => {
      reads += 1;
      return 'light';
    });

    applyTheme('light');

    expect(reads).toBe(0);
  });

  it('re-reads the preference at fire time, so a later settings write is honoured', () => {
    let preference: 'system' | 'light' | 'dark' = 'light';
    watchSystemAppearance(() => preference);

    // The listener is registered once at launch; capturing the preference then
    // would leave it answering for a setting the user has since changed.
    preference = 'system';
    mocks.nativeTheme.shouldUseDarkColors = true;
    mocks.setBackgroundColor.mockClear();
    mocks.emitUpdated();

    expect(mocks.setBackgroundColor).toHaveBeenCalledWith('#171615');
  });
});
