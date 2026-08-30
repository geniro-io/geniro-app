import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_PREFERENCE,
  isThemeId,
  isThemePreference,
  resolveThemePreference,
  THEME_PREFERENCES,
  themeAppearance,
  themePreferenceLabel,
  THEMES,
  themeWindowBackground,
} from './themes';

const THEMES_DIR = join(__dirname, '../renderer/styles/themes');

function backgroundToken(id: string): string | undefined {
  const css = readFileSync(join(THEMES_DIR, `${id}.css`), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  return /--background:\s*([^;]+);/.exec(css)?.[1]?.trim();
}

describe('theme manifest', () => {
  it('names one theme per CSS file, and no more', () => {
    // The two halves of a theme are its file and its row; a row without a file
    // offers the user a theme that paints nothing, and a file without a row is
    // a theme they can never reach.
    const files = readdirSync(THEMES_DIR)
      .filter((name) => name.endsWith('.css'))
      .map((name) => name.replace(/\.css$/, ''))
      .sort();

    expect(THEMES.map((theme) => theme.id).sort()).toEqual(files);
  });

  it.each(THEMES)(
    'carries $id’s own --background as its window background',
    (theme) => {
      // The TWIN the descriptor documents: main paints the window with this
      // value before any stylesheet exists, so a drift shows as a flash of the
      // wrong theme during a resize and nothing else — invisible to every
      // other check in the project.
      expect(theme.windowBackground).toBe(backgroundToken(theme.id));
    },
  );

  it('offers System ahead of the concrete themes, and defaults to it', () => {
    expect(THEME_PREFERENCES[0]).toBe('system');
    expect(DEFAULT_THEME_PREFERENCE).toBe('system');
  });

  it('resolves System from what the OS reports, and ignores it otherwise', () => {
    expect(resolveThemePreference('system', true)).toBe('dark');
    expect(resolveThemePreference('system', false)).toBe('light');
    // An explicit pick is an override: it must survive an OS that disagrees.
    expect(resolveThemePreference('light', true)).toBe('light');
    expect(resolveThemePreference('dark', false)).toBe('dark');
  });

  it('rejects a stored value that is not a theme', () => {
    // settings.json is a file the user can edit, and an older build may have
    // written a theme this one dropped.
    expect(isThemeId('dark')).toBe(true);
    expect(isThemeId('system')).toBe(false);
    expect(isThemeId('solarized')).toBe(false);
    expect(isThemeId(null)).toBe(false);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('solarized')).toBe(false);
  });

  it('labels every preference the picker offers', () => {
    for (const preference of THEME_PREFERENCES) {
      expect(themePreferenceLabel(preference)).not.toBe('');
    }
    expect(themePreferenceLabel('system')).toBe('System');
  });

  it.each(THEMES)('answers $id’s appearance and window background', (theme) => {
    expect(themeAppearance(theme.id)).toBe(theme.appearance);
    expect(themeWindowBackground(theme.id)).toBe(theme.windowBackground);
  });
});
