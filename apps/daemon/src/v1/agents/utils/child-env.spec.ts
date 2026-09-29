import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv, registerIsolatedEnvKeys } from './child-env';

const TOUCHED = [
  'GENIRO_TEST_SECRET',
  'CHILD_ENV_SPEC_ISOLATED',
  'CHILD_ENV_SPEC_UNREGISTERED',
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

  it('strips a registered name and nothing it was not told about', () => {
    // The set is the union adapters register as they are constructed, so the
    // strip must follow the registry exactly: a name nobody registered is an
    // ordinary variable, and a registered one reaches no child by inheritance.
    process.env.CHILD_ENV_SPEC_ISOLATED = 'owned-by-some-cli';
    process.env.CHILD_ENV_SPEC_UNREGISTERED = 'ordinary';
    registerIsolatedEnvKeys(['CHILD_ENV_SPEC_ISOLATED']);

    const env = buildChildEnv();

    expect('CHILD_ENV_SPEC_ISOLATED' in env).toBe(false);
    expect(env.CHILD_ENV_SPEC_UNREGISTERED).toBe('ordinary');
  });

  it('lets extra hand a stripped name back, which is how an adapter re-injects', () => {
    // Merged AFTER the strip: the other order would make every isolated
    // credential unreachable even for the one CLI entitled to it.
    process.env.CHILD_ENV_SPEC_ISOLATED = 'inherited';
    registerIsolatedEnvKeys(['CHILD_ENV_SPEC_ISOLATED']);

    const env = buildChildEnv({ CHILD_ENV_SPEC_ISOLATED: 'handed-over' });

    expect(env.CHILD_ENV_SPEC_ISOLATED).toBe('handed-over');
  });

  it('lets extra override an inherited key', () => {
    process.env.CHILD_ENV_SPEC_PLAIN = 'inherited';

    const env = buildChildEnv({ CHILD_ENV_SPEC_PLAIN: 'overridden' });

    expect(env.CHILD_ENV_SPEC_PLAIN).toBe('overridden');
  });
});
