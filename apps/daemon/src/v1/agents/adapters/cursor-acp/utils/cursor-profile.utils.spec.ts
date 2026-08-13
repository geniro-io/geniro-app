import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

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

    const dir = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(existsSync(join(home, '.cursor', 'mcp.json'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['cli-config.json']);
  });

  it('gives each turn its own directory', () => {
    // Two turns of one run can be in flight together under graph fan-out, and
    // they apply DIFFERENT models — sharing a directory is the same race the
    // per-turn profile exists to remove, moved one level in.
    const base = tempDir('cursor-profiles-');
    const home = fakeHome();

    const first = seedCursorProfile({ baseDir: base, homeDir: home });
    const second = seedCursorProfile({ baseDir: base, homeDir: home });

    expect(first).not.toBe(second);
  });

  it('still yields a usable directory when the user has no config at all', () => {
    // A fresh install, or an unreadable file. The CLI writes its own defaults, so
    // a missing source must not fail the turn over a file we merely wanted.
    const base = tempDir('cursor-profiles-');

    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: tempDir('empty-home-'),
    });

    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('seedCursorProfile — the conversation store', () => {
  it('links acp-sessions at the shared store, not at a directory of its own', () => {
    // The CLI keeps each ACP conversation at `<configDir>/acp-sessions/<id>/`,
    // so a store INSIDE the throwaway profile is deleted with it — which is
    // exactly what shipped, and every cursor chat's second message then died at
    // `session/load` with "Session not found". Drop the link and this fails.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');

    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });

    const link = join(dir, 'acp-sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(store));
  });

  it('creates the store when it does not exist yet — the first ever turn', () => {
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'nested', 'cursor-sessions');
    expect(existsSync(store)).toBe(false);

    seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });

    expect(existsSync(store)).toBe(true);
  });

  it('lets a LATER turn’s profile reach the session the first one wrote', () => {
    // The whole point, asserted on the observable rather than on the link: turn
    // 2 runs under a different profile and must still find turn 1's session
    // directory, because that is what `session/load` reads.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const home = fakeHome();

    const first = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: home,
    });
    // Stand in for the CLI writing a session through the link.
    mkdirSync(join(first, 'acp-sessions', 'session-1'), { recursive: true });
    removeCursorProfile(first);

    const second = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: home,
    });

    expect(existsSync(join(second, 'acp-sessions', 'session-1'))).toBe(true);
  });

  it('leaves the store out when the caller names none — a probe’s own session', () => {
    // `listModels` opens a real `session/new`, and a throwaway handshake's
    // conversation has no business in the store a chat resumes from. Absent
    // means the CLI writes acp-sessions INSIDE the profile, which dies with it.
    const base = tempDir('cursor-profiles-');

    const dir = seedCursorProfile({ baseDir: base, homeDir: fakeHome() });

    expect(existsSync(join(dir, 'acp-sessions'))).toBe(false);
  });
});

describe('removeCursorProfile / sweepStaleCursorProfiles', () => {
  it('removes one turn’s directory and everything the CLI wrote into it', () => {
    const base = tempDir('cursor-profiles-');
    const dir = seedCursorProfile({
      baseDir: base,
      homeDir: fakeHome(),
    });
    // The CLI's own ~690KB cache lands here; the disposer has to take it too.
    writeFileSync(join(dir, 'statsig-cache.json'), '{}');

    removeCursorProfile(dir);

    expect(existsSync(dir)).toBe(false);
  });

  it('unlinks the store rather than deleting the conversations behind it', () => {
    // `node:fs` removes a tree by `lstat`, so the symlink is unlinked instead of
    // descended into. Asserted because the whole scheme rests on it: follow the
    // link and the disposer would delete every cursor thread on every turn.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });
    mkdirSync(join(store, 'session-1'), { recursive: true });

    removeCursorProfile(dir);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(store, 'session-1'))).toBe(true);
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
    seedCursorProfile({ baseDir: base, homeDir: fakeHome() });
    seedCursorProfile({ baseDir: base, homeDir: fakeHome() });
    expect(readdirSync(base).length).toBe(2);

    sweepStaleCursorProfiles(base);

    expect(existsSync(base)).toBe(false);
  });

  it('the boot sweep keeps the conversations — it takes the profiles only', () => {
    // The sweep removes its base WHOLESALE, so a store nested inside it would be
    // deleted on every launch: every cursor thread unresumable after a restart,
    // the same failure the per-turn profile caused, moved to boot. This is what
    // holds the two directories apart.
    const base = tempDir('cursor-profiles-');
    const store = join(tempDir('cursor-store-'), 'cursor-sessions');
    const dir = seedCursorProfile({
      baseDir: base,
      sessionStoreDir: store,
      homeDir: fakeHome(),
    });
    mkdirSync(join(dir, 'acp-sessions', 'session-1'), { recursive: true });

    sweepStaleCursorProfiles(base);

    expect(existsSync(base)).toBe(false);
    expect(existsSync(join(store, 'session-1'))).toBe(true);
  });
});
