import { describe, expect, it } from 'vitest';

import { effectiveConfigDir } from './run-profile';

describe('effectiveConfigDir', () => {
  it('answers the chat’s own profile even when the folder carries a pin', () => {
    // The correction, as a test. Two of this suite's cases used to assert the
    // OPPOSITE, on an override that measurement says does not exist: on claude
    // 2.1.247, from one pinned folder, `CLAUDE_CONFIG_DIR=<A>` loaded profile
    // A's 17 MCP servers and `<B>` profile B's 51 — the folder's own
    // `env.CLAUDE_CONFIG_DIR` never won. Revert the function and this fails.
    expect(
      effectiveConfigDir({
        configDir: '/profiles/personal',
        configDirPin: {
          effective: '/profiles/team',
          source: '/repo/.claude/settings.local.json',
        },
      }),
    ).toBe('/profiles/personal');
  });

  it('answers the chat’s own pick when nothing pins the folder', () => {
    expect(
      effectiveConfigDir({
        configDir: '/profiles/personal',
        configDirPin: null,
      }),
    ).toBe('/profiles/personal');
  });

  it('keeps the CLI’s default as a null rather than inventing a path for it', () => {
    // "The CLI's own profile" is a real answer and has no directory to name —
    // every daemon read takes null to mean exactly that.
    expect(
      effectiveConfigDir({ configDir: null, configDirPin: null }),
    ).toBeNull();
  });

  it('leaves a default-profile chat on the default, pin or no pin', () => {
    // The sharpest of the three readings: with NO variable set, that same
    // pinned folder loaded the default `~/.claude`'s 12 servers rather than the
    // 51 its settings file names. A pin does not fill a silence either.
    expect(
      effectiveConfigDir({
        configDir: null,
        configDirPin: {
          effective: '/profiles/team',
          source: '/repo/.claude/settings.json',
        },
      }),
    ).toBeNull();
  });
});
