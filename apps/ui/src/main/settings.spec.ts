import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, MAX_RUN_CONFIGS } from '../shared/contracts';

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

  it('a saved run configuration round-trips every field', () => {
    const config = {
      id: 'rc-1',
      name: 'Geniro app',
      cwd: '/Users/dev/geniro-app',
      branch: 'feat/some-branch',
      target: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
      contextWindow: '1m',
      modelParameters: { optimize_for: 'intelligence' },
      approval: 'acceptEdits',
      configDir: '/Users/dev/.config/work',
    };
    writeRaw({ runConfigs: [config] });

    expect(readSettings().runConfigs).toEqual([config]);
  });

  it('reads a configuration written BEFORE the context-window and parameter fields existed', () => {
    // The file on disk predates the field and `runConfigSchema` is strict, so
    // required it would fail to parse — and the entry-by-entry salvage this
    // suite exists for would then drop every configuration the user had. It
    // reads as "no size chosen", which is what those entries mean.
    const legacy = {
      id: 'rc-old',
      name: 'From an older build',
      cwd: '/Users/dev/geniro-app',
      branch: null,
      target: 'claude',
      model: null,
      effort: null,
      approval: null,
      configDir: null,
    };
    writeRaw({ runConfigs: [legacy] });

    expect(readSettings().runConfigs).toEqual([
      { ...legacy, contextWindow: null, modelParameters: {} },
    ]);
  });

  it('one unparseable run configuration costs only that entry — the others survive in order', () => {
    // A configuration is HAND-MADE and unrecoverable. Rejecting the array
    // wholesale (zod's default on one bad element) would wipe every saved setup
    // over one entry written by a newer build, and the next updateSettings()
    // write would make that permanent.
    writeRaw({
      runConfigs: [
        {
          id: 'rc-1',
          name: 'First',
          cwd: '/Users/dev/one',
          branch: null,
          target: 'claude',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
        { id: 'rc-2', name: 'Corrupt', cwd: 'not-absolute' },
        {
          id: 'rc-3',
          name: 'Third',
          cwd: '/Users/dev/three',
          branch: null,
          target: 'cursor-agent',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
      ],
    });

    const kept = readSettings().runConfigs;
    expect(kept.map((c) => c.id)).toEqual(['rc-1', 'rc-3']);
  });

  it('a run configuration whose branch is argv-hostile is dropped, not stored', () => {
    // `branch` becomes an argv entry of `git switch`. A leading dash would be
    // read as a flag, so the refname guard is what keeps a hand-edited
    // settings.json from reaching that call — this pins that the settings read
    // applies it, not merely that the IPC write does.
    writeRaw({
      runConfigs: [
        {
          id: 'rc-bad',
          name: 'Hostile',
          cwd: '/Users/dev/one',
          branch: '--upload-pack=touch /tmp/pwned',
          target: 'claude',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
      ],
    });

    expect(readSettings().runConfigs).toEqual([]);
  });

  it('a list longer than the cap is truncated on read, not loaded whole', () => {
    // The cap lives on the ARRAY schema, which the per-entry salvage skips.
    // Unre-applied, an over-long hand-edited file loads in full and then makes
    // every later write fail its own schema — locking the user out of saving.
    writeRaw({
      runConfigs: Array.from({ length: MAX_RUN_CONFIGS + 5 }, (_, i) => ({
        id: `rc-${i}`,
        name: `Config ${i}`,
        cwd: `/Users/dev/p${i}`,
        branch: null,
        target: 'claude',
        model: null,
        effort: null,
        approval: null,
        configDir: null,
      })),
    });

    const kept = readSettings().runConfigs;
    expect(kept).toHaveLength(MAX_RUN_CONFIGS);
    // Truncated from the END, not the start: the order is the user's own
    // arrangement (the sibling test above pins that), so slicing the other way
    // would silently delete their FIRST configurations rather than the overflow.
    expect(kept[0]?.id).toBe('rc-0');
    expect(kept[kept.length - 1]?.id).toBe(`rc-${MAX_RUN_CONFIGS - 1}`);
  });

  it('a duplicated id costs the later entry — ids are unique after a read', () => {
    // `id` carries no uniqueness constraint and settings.json is hand-editable.
    // Downstream, edit and delete both key on id across the WHOLE list — so a
    // duplicate makes renaming one configuration silently rewrite another, and
    // deleting one remove two. Enforcing it here keeps that in one place rather
    // than making every consumer defensive.
    writeRaw({
      runConfigs: [
        {
          id: 'dup',
          name: 'First',
          cwd: '/Users/dev/one',
          branch: null,
          target: 'claude',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
        {
          id: 'dup',
          name: 'Second',
          cwd: '/Users/dev/two',
          branch: null,
          target: 'claude',
          model: null,
          effort: null,
          approval: null,
          configDir: null,
        },
      ],
    });

    const kept = readSettings().runConfigs;
    expect(kept).toHaveLength(1);
    // The FIRST wins, matching the order-preserving rule the sibling tests pin.
    expect(kept[0]?.name).toBe('First');
  });

  it('a non-array runConfigs falls back to the default empty list', () => {
    writeRaw({ runConfigs: { not: 'an array' }, onboardingComplete: true });

    const settings = readSettings();
    expect(settings.runConfigs).toEqual([]);
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
