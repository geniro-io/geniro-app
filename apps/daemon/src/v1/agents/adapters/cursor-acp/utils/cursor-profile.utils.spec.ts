import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tempDir } from '../../../__tests__/temp-dir';
import {
  removeCursorProfile,
  seedCursorProfile,
  sweepStaleCursorProfiles,
} from './cursor-profile.utils';

/** A fake user home whose `.cursor` holds the two files a real one does. */
function fakeHome(config = '{"model":{"modelId":"claude-opus-5"}}'): string {
  const home = tempDir('cursor-home-');
  const dir = join(home, '.cursor');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cli-config.json'), config);
  // Present so the "not copied" assertion below is about a file that EXISTS —
  // otherwise it would pass for the wrong reason.
  writeFileSync(
    join(dir, 'mcp.json'),
    '{"mcpServers":{"x":{"url":"http://x"}}}',
  );
  return home;
}

describe('seedCursorProfile', () => {
  it("copies the user's cli-config.json, so the turn keeps their settings", () => {
    // The copy is what makes a run that names no model still open on the model
    // the user chose, and keeps their permissions/approvalMode.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome('{"approvalMode":"allowlist"}');

    const dir = seedCursorProfile(base, home);

    expect(readFileSync(join(dir, 'cli-config.json'), 'utf8')).toBe(
      '{"approvalMode":"allowlist"}',
    );
  });

  it('never copies mcp.json — a 0600 file holding the user’s own tokens', () => {
    // Measured to be unnecessary: under a directory holding only cli-config.json
    // an ACP session still loads the folder's MCP servers, because the CLI
    // resolves that file from the user's home either way. So copying it would
    // duplicate credentials into a temp dir for nothing.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome();

    const dir = seedCursorProfile(base, home);

    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['cli-config.json']);
  });

  it('gives each turn its own directory', () => {
    // Two turns of one run can be in flight together under graph fan-out, and
    // they apply DIFFERENT models — sharing a directory is the same race the
    // per-turn profile exists to remove, moved one level in.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome();

    const first = seedCursorProfile(base, home);
    const second = seedCursorProfile(base, home);

    expect(first).not.toBe(second);
  });

  it('still yields a usable directory when the user has no config at all', () => {
    // A fresh install, or an unreadable file. The CLI writes its own defaults, so
    // a missing source must not fail the turn over a file we merely wanted.
    const base = tempDir('cursor-profiles-');

    const dir = seedCursorProfile(base, tempDir('empty-home-'));

    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('removeCursorProfile / sweepStaleCursorProfiles', () => {
  it('removes one turn’s directory and everything the CLI wrote into it', () => {
    const base = tempDir('cursor-profiles-');
    const dir = seedCursorProfile(base, fakeHome());
    // The CLI's own ~690KB cache lands here; the disposer has to take it too.
    writeFileSync(join(dir, 'statsig-cache.json'), '{}');

    removeCursorProfile(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('does not throw on a directory that is already gone', () => {
    // The disposer runs on exactly one settle path, but a boot sweep may have
    // taken the whole base directory first.
    expect(() =>
      removeCursorProfile(join(tempDir('cursor-profiles-'), 'nope')),
    ).not.toThrow();
  });

  it('sweeps what a SIGKILLed daemon left behind', () => {
    // The only way a leftover exists: a killed daemon runs no disposer at all.
    const base = tempDir('cursor-profiles-');
    seedCursorProfile(base, fakeHome());
    seedCursorProfile(base, fakeHome());
    expect(readdirSync(base).length).toBe(2);

    sweepStaleCursorProfiles(base);

    expect(existsSync(base)).toBe(false);
  });
});
