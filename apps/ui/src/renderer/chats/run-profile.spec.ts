import { describe, expect, it } from 'vitest';

import { accountConfigDir, effectiveConfigDir } from './run-profile';

const PIN = {
  effective: '/profiles/team',
  source: '/repo/.claude/settings.local.json',
};

describe('effectiveConfigDir', () => {
  it('answers the chat’s own profile even when the folder carries a pin', () => {
    // What the CLI reads its CONFIGURATION from, and the pin does not reach
    // it: from one pinned folder on 2.1.247, `CLAUDE_CONFIG_DIR=<A>` loaded
    // profile A's 17 MCP servers and `<B>` profile B's 51 — the folder's own
    // `env.CLAUDE_CONFIG_DIR` never decided that. Point this at the pin and
    // the MCP panel goes back to listing servers the agent has not loaded.
    expect(
      effectiveConfigDir({
        configDir: '/profiles/personal',
        configDirPin: PIN,
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
    // pinned folder loaded the default `~/.claude`'s 12 servers rather than
    // the 51 its settings file names. A pin does not fill a silence either.
    expect(
      effectiveConfigDir({ configDir: null, configDirPin: PIN }),
    ).toBeNull();
  });
});

describe('accountConfigDir', () => {
  it('answers the PINNED profile — the account a turn actually ends up on', () => {
    // The correction, as a test, and the one this suite got backwards twice.
    // Measured 2026-08-28 on 2.1.247 with `CLAUDE_CONFIG_DIR` naming a
    // personal `max` profile for the whole run, asking `get_usage` every 12s:
    // from a folder pinning the team profile the reply was `max` at +4s…+25s
    // and `team` from +37s on, while from an UNPINNED folder it stayed `max`
    // for the full two minutes. The pin wins; it just wins late.
    //
    // Revert this to `run.configDir` and the header goes back to naming the
    // profile the user picked over plan limits belonging to another account —
    // which is the defect, reported three times.
    expect(
      accountConfigDir({ configDir: '/profiles/personal', configDirPin: PIN }),
    ).toBe('/profiles/team');
  });

  it('answers the chat’s own pick when nothing pins the folder', () => {
    expect(
      accountConfigDir({ configDir: '/profiles/personal', configDirPin: null }),
    ).toBe('/profiles/personal');
  });

  it('takes the pin over the CLI’s default too', () => {
    // A chat on the default profile is not exempt: the pin names a directory
    // and the CLI applies it the same way, so a run that chose nothing still
    // ends up on the pinned account.
    expect(accountConfigDir({ configDir: null, configDirPin: PIN })).toBe(
      '/profiles/team',
    );
  });

  it('is null only when neither side names a profile', () => {
    expect(
      accountConfigDir({ configDir: null, configDirPin: null }),
    ).toBeNull();
  });
});
