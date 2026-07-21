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

  it("a future agent kind inside cliPaths costs only that entry — this build's known CLI paths survive", () => {
    // The salvage exists for version skew (a settings.json written by a NEWER
    // build under the notify-only brew flow). The most likely schema growth is
    // a new CLI agent kind, which lands as an extra cliPaths entry — that
    // unknown entry must not take the user's still-valid claude/cursor paths
    // down with it: cliPaths values are execFile targets the user configured
    // by hand, and the next updateSettings() write makes any loss permanent.
    writeRaw({
      onboardingComplete: true,
      cliPaths: {
        claude: '/usr/local/bin/claude',
        'future-agent': '/opt/future/bin/future-agent',
      },
    });

    const settings = readSettings();
    expect(settings.cliPaths).toEqual({ claude: '/usr/local/bin/claude' });
    expect(settings.onboardingComplete).toBe(true);
  });

  it('one invalid cliPaths entry (relative path) costs only that entry — the valid sibling survives', () => {
    // Same blast-radius rule one level down: a corrupted or hand-edited
    // relative path under one agent kind must not silently drop the OTHER
    // agent's valid absolute path (which then never spawns from its
    // configured binary again after the next settings write).
    writeRaw({
      cliPaths: {
        claude: '/usr/local/bin/claude',
        'cursor-agent': 'not-an-absolute-path',
      },
    });

    expect(readSettings().cliPaths).toEqual({
      claude: '/usr/local/bin/claude',
    });
  });
});
