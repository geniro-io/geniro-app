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

  it('a stored theme survives a read', () => {
    writeRaw({ theme: 'dark' });

    expect(readSettings().theme).toBe('dark');
  });

  it('a theme this build no longer ships costs only that key, and falls back to System', () => {
    // Version skew is normal under the notify-only brew flow, so a settings.json
    // written by a newer build can name a theme whose CSS file this one does not
    // have. Painting nothing is not an option; System is.
    writeRaw({ theme: 'solarized', onboardingComplete: true });

    const settings = readSettings();
    expect(settings.theme).toBe('system');
    expect(settings.onboardingComplete).toBe(true);
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
    //
    // This is not hypothetical here: the configurations recovered after the
    // key was dropped from the schema are exactly this shape.
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

  it('a run configuration whose branch is argv-hostile is dropped, not stored', () => {
    // `branch` becomes an argv entry of `git switch`. A leading dash would be
    // read as a flag, so the refname guard is what keeps a hand-edited
    // settings.json from reaching that call — this pins that the settings read
    // applies it, not merely that the IPC write does. Nothing on the fast-action
    // side can cover this: an action reaches no privileged sink.
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

  it('salvages named configurations entry-by-entry, on the same one function', () => {
    // The THIRD hand-managed list to go through `salvageList`, and this is what
    // stops it being the one that silently loses the fix the other two have. A
    // configuration is a name and a colour the user typed onto a directory —
    // unrecoverable, like an action, so one bad row written by a newer build
    // must not take the rest with it.
    writeRaw({
      configProfiles: [
        {
          id: 'cp-1',
          name: 'Work',
          dir: '/Users/x/.claude-work',
          color: 'blue',
        },
        // Colour outside the palette: the one field here that is ENUMERATED
        // rather than a bounded string, because the palette is the app's own.
        {
          id: 'cp-2',
          name: 'Broken',
          dir: '/Users/x/.claude-b',
          color: 'chartreuse',
        },
        // A relative directory — `absolutePath` refuses it, and a run pointed
        // at one would resolve against whatever cwd the daemon happened to have.
        { id: 'cp-3', name: 'Relative', dir: '.claude-rel', color: 'green' },
        { id: 'cp-4', name: 'Lab', dir: '/Users/x/.claude-lab', color: 'teal' },
      ],
    });

    const kept = readSettings().configProfiles;
    expect(kept.map((p) => p.id)).toEqual(['cp-1', 'cp-4']);
  });

  it('drops a DUPLICATE configuration id rather than letting one row shadow another', () => {
    // Ids must be unique across every hand-managed list, and only the read path
    // can guarantee it: every consumer keys on the id, so a duplicate in a
    // hand-edited file makes renaming one entry rewrite another and deleting
    // one remove two.
    writeRaw({
      configProfiles: [
        {
          id: 'cp-1',
          name: 'Work',
          dir: '/Users/x/.claude-work',
          color: 'blue',
        },
        {
          id: 'cp-1',
          name: 'Shadow',
          dir: '/Users/x/.claude-two',
          color: 'red',
        },
      ],
    });

    const kept = readSettings().configProfiles;
    expect(kept).toHaveLength(1);
    expect(kept[0]!.name).toBe('Work');
  });

  it('salvages run configurations entry-by-entry, exactly as it does actions', () => {
    // The two lists share ONE salvage function, so this is what stops that
    // function from being fixed for one list and left broken for the other —
    // and a configuration is hand-made and unrecoverable, which is the whole
    // reason the salvage is per entry rather than per array.
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

    expect(readSettings().runConfigs.map((c) => c.id)).toEqual([
      'rc-1',
      'rc-3',
    ]);
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
