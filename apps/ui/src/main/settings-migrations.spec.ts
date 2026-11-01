import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import { readSettings } from './settings';
import {
  migrateSettingsFile,
  SETTINGS_BACKUPS_DIR,
  type SettingsMigration,
} from './settings-migrations';

const NOW = new Date('2026-11-01T10:20:30.000Z');

const renamesInstructions: SettingsMigration = {
  version: 1,
  id: 'settings-0001-rename-instructions',
  migrate: ({ legacyInstructions, ...rest }) => ({
    ...rest,
    customInstructions: legacyInstructions,
  }),
};

const addsLanguage: SettingsMigration = {
  version: 2,
  id: 'settings-0002-language',
  migrate: (raw) => ({ ...raw, replyLanguage: 'Russian' }),
};

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'geniro-settings-migrations-'));
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

const settingsPath = (): string => join(mocks.userData, 'settings.json');

function writeRaw(text: string): void {
  writeFileSync(settingsPath(), text, 'utf8');
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('migrateSettingsFile', () => {
  it('migrates raw settings before salvage and backs the file up', () => {
    const original = JSON.stringify({
      onboardingComplete: true,
      legacyInstructions: 'Be brief.',
    });
    writeRaw(original);

    const result = migrateSettingsFile(
      mocks.userData,
      [renamesInstructions],
      NOW,
    );

    expect(result).toEqual({
      from: 0,
      to: 1,
      backup: join(
        mocks.userData,
        SETTINGS_BACKUPS_DIR,
        'settings-0001-rename-instructions-2026-11-01T10-20-30.000Z',
        'settings.json',
      ),
    });
    expect(readFileSync(result?.backup ?? '', 'utf8')).toBe(original);
    expect(readRaw()).toEqual({
      onboardingComplete: true,
      customInstructions: 'Be brief.',
      settingsVersion: 1,
    });
    const settings = readSettings();
    expect(settings.customInstructions).toBe('Be brief.');
    expect(settings.settingsVersion).toBe(1);
  });

  it('applies only the steps above the stored version', () => {
    writeRaw(JSON.stringify({ settingsVersion: 1, replyLanguage: '' }));

    const result = migrateSettingsFile(
      mocks.userData,
      [renamesInstructions, addsLanguage],
      NOW,
    );

    expect(result?.from).toBe(1);
    expect(readRaw()).toEqual({ settingsVersion: 2, replyLanguage: 'Russian' });
  });

  it('leaves a current file, a missing file and an unreadable file alone', () => {
    expect(
      migrateSettingsFile(mocks.userData, [renamesInstructions], NOW),
    ).toBeNull();
    expect(existsSync(settingsPath())).toBe(false);

    writeRaw('{"settingsVersion": 1, "legacyInstructions": "kept"}');
    expect(
      migrateSettingsFile(mocks.userData, [renamesInstructions], NOW),
    ).toBeNull();
    expect(readRaw()).toEqual({
      settingsVersion: 1,
      legacyInstructions: 'kept',
    });

    writeRaw('{ not json');
    expect(
      migrateSettingsFile(mocks.userData, [renamesInstructions], NOW),
    ).toBeNull();
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ not json');
    expect(existsSync(join(mocks.userData, SETTINGS_BACKUPS_DIR))).toBe(false);
  });

  it('never steps a file written by a newer build back', () => {
    writeRaw(JSON.stringify({ settingsVersion: 7 }));

    expect(
      migrateSettingsFile(mocks.userData, [renamesInstructions], NOW),
    ).toBeNull();
    expect(readSettings().settingsVersion).toBe(7);
  });

  it('refuses a registry whose versions do not increase', () => {
    writeRaw('{}');

    expect(() =>
      migrateSettingsFile(
        mocks.userData,
        [addsLanguage, renamesInstructions],
        NOW,
      ),
    ).toThrow(/not above 2/);
    expect(readdirSync(mocks.userData)).toEqual(['settings.json']);
  });
});
