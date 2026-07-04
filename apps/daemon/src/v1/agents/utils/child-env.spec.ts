import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv } from './child-env';

const TOUCHED = [
  'GENIRO_TEST_SECRET',
  'GENIRO_CURSOR_API_KEY',
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

  it('merges extra over the stripped env (single-secret re-injection)', () => {
    process.env.GENIRO_CURSOR_API_KEY = 'cursor-key';

    const env = buildChildEnv({ CURSOR_API_KEY: 'cursor-key' });

    expect(env.GENIRO_CURSOR_API_KEY).toBeUndefined();
    expect(env.CURSOR_API_KEY).toBe('cursor-key');
  });

  it('lets extra override an inherited key', () => {
    process.env.CHILD_ENV_SPEC_PLAIN = 'inherited';

    const env = buildChildEnv({ CHILD_ENV_SPEC_PLAIN: 'overridden' });

    expect(env.CHILD_ENV_SPEC_PLAIN).toBe('overridden');
  });
});
