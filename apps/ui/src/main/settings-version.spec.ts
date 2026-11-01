import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));
vi.mock('./settings-migrations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settings-migrations')>()),
  SETTINGS_VERSION: 3,
}));

import { readSettings, updateSettings } from './settings';

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'geniro-settings-version-'));
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

const settingsPath = (): string => join(mocks.userData, 'settings.json');

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('settingsVersion', () => {
  it('stamps a new install with the current version, so no migration runs over a file already in the new shape', () => {
    expect(readSettings().settingsVersion).toBe(3);

    updateSettings({ onboardingComplete: true });

    expect(readRaw().settingsVersion).toBe(3);
  });

  it('keeps the keys a migration still has to carry while the file is below the current version', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ settingsVersion: 1, legacyInstructions: 'Be brief.' }),
    );

    updateSettings({ onboardingComplete: true });

    expect(readRaw()).toMatchObject({
      settingsVersion: 1,
      legacyInstructions: 'Be brief.',
      onboardingComplete: true,
    });
  });

  it('keeps a known key in its old shape while the file is below the current version', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ settingsVersion: 1, theme: { legacy: 'dark' } }),
    );
    expect(readSettings().theme).toBe('system');

    updateSettings({ onboardingComplete: true });

    expect(readRaw().theme).toEqual({ legacy: 'dark' });

    updateSettings({ theme: 'system' });

    expect(readRaw().theme).toBe('system');
  });

  it('drops keys this build does not know once the file is current', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ settingsVersion: 3, legacyInstructions: 'Be brief.' }),
    );

    updateSettings({ onboardingComplete: true });

    expect(readRaw()).not.toHaveProperty('legacyInstructions');
  });
});
