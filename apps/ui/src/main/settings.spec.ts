import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS } from '../shared/contracts';

const mocks = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mocks.userData) },
}));

import { readSettings } from './settings';

beforeEach(() => {
  mocks.userData = mkdtempSync(join(tmpdir(), 'geniro-settings-spec-'));
});

afterEach(() => {
  rmSync(mocks.userData, { recursive: true, force: true });
});

function writeRaw(value: unknown): void {
  mkdirSync(mocks.userData, { recursive: true });
  writeFileSync(
    join(mocks.userData, 'settings.json'),
    JSON.stringify(value),
    'utf8',
  );
}

describe('readSettings', () => {
  it('merges a validated older partial file over defaults', () => {
    writeRaw({ onboardingComplete: true });

    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
    });
  });

  it('an invalid key costs only that key — valid siblings survive', () => {
    // Version skew is normal under the notify-only brew flow: a downgraded
    // build must not reset EVERY setting (and have the next write make the
    // loss permanent) because one key fails its parse.
    writeRaw({
      cliPaths: null,
      checkForUpdates: 'yes',
      onboardingComplete: true,
    });

    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      onboardingComplete: true,
    });
  });

  it('an unknown persisted key is ignored — never cast into Settings, never a reset', () => {
    writeRaw({ unexpected: 'value', onboardingComplete: true });

    const settings = readSettings();
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, onboardingComplete: true });
    expect('unexpected' in settings).toBe(false);
  });

  it('a non-object file still falls back to full defaults', () => {
    writeRaw(['not', 'an', 'object']);

    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
