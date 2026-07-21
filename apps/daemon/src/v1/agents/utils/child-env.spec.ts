import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv, claudeCredentialEnv } from './child-env';

const TOUCHED = [
  'GENIRO_TEST_SECRET',
  'GENIRO_CURSOR_API_KEY',
  'CURSOR_API_KEY',
  'CLAUDE_CODE_SESSION_ID',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
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

  it('merges extra over the stripped env (single-secret re-injection)', () => {
    process.env.GENIRO_CURSOR_API_KEY = 'cursor-key';
    process.env.CURSOR_API_KEY = 'inherited-key';

    const env = buildChildEnv({ CURSOR_API_KEY: 'cursor-key' });

    expect(env.GENIRO_CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBe('cursor-key');
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
