import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyNativeAppearance } from './native-appearance';

const mocks = vi.hoisted(() => ({
  nativeTheme: { themeSource: 'system' as 'system' | 'light' | 'dark' },
}));

vi.mock('electron', () => ({ nativeTheme: mocks.nativeTheme }));

describe('applyNativeAppearance', () => {
  beforeEach(() => {
    mocks.nativeTheme.themeSource = 'system';
  });

  it('declares the app light, so macOS stops drawing its chrome for Dark', () => {
    // The whole defect in one assertion: left at 'system', a Mac in Dark mode
    // tints the inactive traffic lights near-white and they disappear into
    // this app's near-white title bar.
    applyNativeAppearance();

    expect(mocks.nativeTheme.themeSource).toBe('light');
  });
});
