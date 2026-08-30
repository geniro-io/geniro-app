import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, MAX_FAST_ACTIONS } from '../shared/contracts';

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

  it('a saved fast action round-trips every field', () => {
    const fa = {
      id: 'fa-1',
      name: 'Review the branch',
      description: 'Review what changed on this branch and report findings.',
    };
    writeRaw({ fastActions: [fa] });

    expect(readSettings().fastActions).toEqual([fa]);
  });

  it('one unparseable fast action costs only that entry — the others survive in order', () => {
    // An action is HAND-WRITTEN and unrecoverable. Rejecting the array
    // wholesale (zod's default on one bad element) would wipe every one of them
    // over a single row written by a newer build, and the next updateSettings()
    // write would make that permanent.
    writeRaw({
      fastActions: [
        { id: 'fa-1', name: 'First', description: 'Do the first thing.' },
        { id: 'fa-2', name: 'Corrupt', description: '' },
        { id: 'fa-3', name: 'Third', description: 'Do the third thing.' },
      ],
    });

    const kept = readSettings().fastActions;
    expect(kept.map((a) => a.id)).toEqual(['fa-1', 'fa-3']);
  });

  it('a list longer than the cap is truncated on read, not loaded whole', () => {
    // The cap lives on the ARRAY schema, which the per-entry salvage skips.
    // Unre-applied, an over-long hand-edited file loads in full and then makes
    // every later write fail its own schema — locking the user out of saving.
    writeRaw({
      fastActions: Array.from({ length: MAX_FAST_ACTIONS + 5 }, (_, i) => ({
        id: `fa-${i}`,
        name: `Action ${i}`,
        description: `Do thing ${i}.`,
      })),
    });

    const kept = readSettings().fastActions;
    expect(kept).toHaveLength(MAX_FAST_ACTIONS);
    // Truncated from the END, not the start: the order is the user's own
    // arrangement of their buttons, so slicing the other way would silently
    // delete their FIRST actions rather than the overflow.
    expect(kept[0]?.id).toBe('fa-0');
    expect(kept[kept.length - 1]?.id).toBe(`fa-${MAX_FAST_ACTIONS - 1}`);
  });

  it('a duplicated id costs the later entry — ids are unique after a read', () => {
    // `id` carries no uniqueness constraint and settings.json is hand-editable.
    // Downstream, edit and delete both key on id across the WHOLE list — so a
    // duplicate makes renaming one action silently rewrite another, and
    // deleting one remove two. Enforcing it here keeps that in one place rather
    // than making every consumer defensive.
    writeRaw({
      fastActions: [
        { id: 'dup', name: 'First', description: 'One.' },
        { id: 'dup', name: 'Second', description: 'Two.' },
      ],
    });

    const kept = readSettings().fastActions;
    expect(kept).toHaveLength(1);
    // The FIRST wins, matching the order-preserving rule the sibling tests pin.
    expect(kept[0]?.name).toBe('First');
  });

  it('a non-array fastActions falls back to the default empty list', () => {
    writeRaw({ fastActions: { not: 'an array' }, onboardingComplete: true });

    const settings = readSettings();
    expect(settings.fastActions).toEqual([]);
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
