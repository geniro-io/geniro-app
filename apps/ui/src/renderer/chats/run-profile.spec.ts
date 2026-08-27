import { describe, expect, it } from 'vitest';

import { effectiveConfigDir } from './run-profile';

describe('effectiveConfigDir', () => {
  it('answers the FOLDER’s pin, because that is what the CLI ends up using', () => {
    // REPORTED as "Chat cn see datadog, but i cant see it in the list": the MCP
    // panel asked under the profile the chat was pointed at and got 15 servers,
    // while the agent had loaded the pinned profile's 50 — Datadog among them.
    expect(
      effectiveConfigDir({
        configDir: '/profiles/personal',
        configDirPin: {
          effective: '/profiles/team',
          source: '/repo/.claude/settings.local.json',
        },
      }),
    ).toBe('/profiles/team');
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

  it('lets a pin decide even for a chat that asked for the default', () => {
    // The override does not care that the chat named no profile: the CLI reads
    // the folder either way, so a default-profile chat in a pinned folder is
    // not running on the default.
    expect(
      effectiveConfigDir({
        configDir: null,
        configDirPin: {
          effective: '/profiles/team',
          source: '/repo/.claude/settings.json',
        },
      }),
    ).toBe('/profiles/team');
  });
});
