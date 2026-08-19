import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv, claudeCredentialEnv } from './child-env';

const TOUCHED = [
  'GENIRO_TEST_SECRET',
  'GENIRO_CURSOR_API_KEY',
  'CURSOR_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_ENABLE_CFC',
  'CHILD_ENV_SPEC_PLAIN',
] as const;

describe('buildChildEnv', () => {
  afterEach(() => {
    for (const key of TOUCHED) {
      delete process.env[key];
    }
  });

  it('strips every GENIRO_-prefixed key from the daemon env', () => {
    process.env.GENIRO_TEST_SECRET = 'super-secret';
    process.env.CHILD_ENV_SPEC_PLAIN = 'kept';

    const env = buildChildEnv();

    expect(env.GENIRO_TEST_SECRET).toBeUndefined();
    expect(env.CHILD_ENV_SPEC_PLAIN).toBe('kept');
  });

  it('strips an outer Claude Code session identity from every child', () => {
    // Launching the app from inside a Claude Code session exports this var.
    // It names the OUTER session — a spawned agent's conversation never is
    // that session, so the daemon must not advertise it to children.
    process.env.CLAUDE_CODE_SESSION_ID = 'outer-session';

    expect(buildChildEnv().CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('strips an inherited claude config directory, so a chat keeps its OWN profile', () => {
    // The daemon may be launched from a shell that chose a profile for itself.
    // A chat's config directory is part of the run's identity — picked in the UI
    // and stored on the run row — so inheriting this made a chat that named
    // NONE run under a different account, resuming a session id that is not in
    // that profile's store at all.
    process.env.CLAUDE_CONFIG_DIR = '/Users/someone/.claude-other-profile';

    expect(buildChildEnv().CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('strips inherited browser tools, so the SETTING decides and not the shell', () => {
    // The one stripped name that guards a preference rather than an identity.
    // `ClaudeAdapter.buildEnv` sets it only when the user switched the browser
    // tools on; inherited, it turns 22 tool schemas back on in every prompt of
    // every turn with the switch off and nothing on screen saying so. Claude
    // Code's own terminal exports `=1`, so a daemon launched from one had it.
    process.env.CLAUDE_CODE_ENABLE_CFC = '1';

    expect(buildChildEnv().CLAUDE_CODE_ENABLE_CFC).toBeUndefined();
  });

  it('lets the adapter hand the browser tools over on top of the strip', () => {
    // The strip must not make the feature unreachable: the ONE path allowed to
    // turn it on passes it as `extra`, which wins.
    process.env.CLAUDE_CODE_ENABLE_CFC = '1';

    expect(
      buildChildEnv({ CLAUDE_CODE_ENABLE_CFC: '1' }).CLAUDE_CODE_ENABLE_CFC,
    ).toBe('1');
  });

  it('still lets the run’s OWN config directory through as extra', () => {
    // The other direction: stripping must not disarm the feature. The adapter
    // passes the run's directory as `extra`, which wins over the stripped
    // inheritance — this is the assertion that fails if the key is stripped
    // AFTER the merge instead of before it.
    process.env.CLAUDE_CONFIG_DIR = '/Users/someone/.claude-other-profile';

    const env = buildChildEnv({ CLAUDE_CONFIG_DIR: '/runs/own-profile' });

    expect(env.CLAUDE_CONFIG_DIR).toBe('/runs/own-profile');
  });

  it('strips an inherited CURSOR_API_KEY when nothing re-injects it', () => {
    // The claude-side half of the isolation rule, pinned on its own rather than
    // only via the re-injecting case below: a user's exported Cursor key must
    // not reach a child that no adapter handed it to.
    process.env.CURSOR_API_KEY = 'inherited-key';

    expect(buildChildEnv().CURSOR_API_KEY).toBeUndefined();
  });

  it('merges extra over the stripped env (single-secret re-injection)', () => {
    // The strip is by PREFIX, so any GENIRO_ name exercises it. This used to
    // assert on `GENIRO_CURSOR_API_KEY`, which nothing sets any more — pinning a
    // retired variable proves nothing about the rule.
    process.env.GENIRO_TEST_SECRET = 'should-not-reach-a-child';
    process.env.CURSOR_API_KEY = 'inherited-key';

    const env = buildChildEnv({ CURSOR_API_KEY: 'adapter-supplied' });

    expect(env.GENIRO_TEST_SECRET).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBe('adapter-supplied');
  });

  it('lets extra override an inherited key', () => {
    process.env.CHILD_ENV_SPEC_PLAIN = 'inherited';

    const env = buildChildEnv({ CHILD_ENV_SPEC_PLAIN: 'overridden' });

    expect(env.CHILD_ENV_SPEC_PLAIN).toBe('overridden');
  });

  it('strips inherited Anthropic credentials from every child', () => {
    // Symmetry with the cursor direction: a cursor child (or its tool
    // grandchildren) must never inherit another agent's credential.
    process.env.ANTHROPIC_API_KEY = 'sk-ant';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';

    const env = buildChildEnv();

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  describe('claudeCredentialEnv', () => {
    it('returns exactly the inherited Anthropic credentials that are set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant';

      expect(claudeCredentialEnv()).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' });
    });

    it('returns an empty record when the daemon inherited none', () => {
      expect(claudeCredentialEnv()).toEqual({});
    });

    it('round-trips through buildChildEnv extra (claude-child re-injection)', () => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';

      const env = buildChildEnv(claudeCredentialEnv());

      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    });
  });
});
