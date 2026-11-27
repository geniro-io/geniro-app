import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildChildEnv, registerIsolatedEnvKeys } from './child-env';
import {
  installChildKillGuard,
  KILL_GUARD_USER_BASH_ENV_ENV,
  KILL_GUARD_USER_ZDOTDIR_ENV,
} from './child-kill-guard';

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

  it('strips the daemon’s Electron-as-Node switch but keeps the user’s other ELECTRON_ keys', () => {
    // The daemon runs as `ELECTRON_RUN_AS_NODE=1 electron`; inherited, every
    // Electron app an agent starts boots as plain Node.
    const saved = {
      run: process.env.ELECTRON_RUN_AS_NODE,
      mirror: process.env.ELECTRON_MIRROR,
    };
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.ELECTRON_MIRROR = 'https://mirror.example/electron/';
    try {
      const env = buildChildEnv();

      expect('ELECTRON_RUN_AS_NODE' in env).toBe(false);
      expect(env.ELECTRON_MIRROR).toBe('https://mirror.example/electron/');
      // A caller that means to run Electron as Node still can, explicitly.
      expect(
        buildChildEnv({ ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE,
      ).toBe('1');
    } finally {
      for (const [key, value] of [
        ['ELECTRON_RUN_AS_NODE', saved.run],
        ['ELECTRON_MIRROR', saved.mirror],
      ] as const) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
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

describe('buildChildEnv with the kill guard installed', () => {
  const saved = {
    ZDOTDIR: process.env.ZDOTDIR,
    BASH_ENV: process.env.BASH_ENV,
  };
  let root = '';
  let uninstall: () => void = () => undefined;

  afterEach(() => {
    uninstall();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function install(): string {
    root = mkdtempSync(join(tmpdir(), 'child-env-guard-'));
    const dir = join(root, 'kill-guard');
    uninstall = installChildKillGuard(dir, {
      builtin: ['true'],
      external: '/usr/bin/true',
    });
    return dir;
  }

  it('starts every child under the guard, after whatever extra sets', () => {
    const dir = install();

    const env = buildChildEnv({ PATH: '/opt/tool/bin', ZDOTDIR: '/u/zsh' });

    expect(env.ZDOTDIR).toBe(dir);
    expect(env.BASH_ENV).toBe(join(dir, 'bash-env'));
    expect(env.PATH).toBe(`${join(dir, 'bin')}:/opt/tool/bin`);
    expect(env[KILL_GUARD_USER_ZDOTDIR_ENV]).toBe('/u/zsh');
  });

  it("carries the daemon's own ZDOTDIR and BASH_ENV as the user's", () => {
    install();
    process.env.ZDOTDIR = '/u/config/zsh';
    process.env.BASH_ENV = '/u/bash-env';

    const env = buildChildEnv();

    expect(env[KILL_GUARD_USER_ZDOTDIR_ENV]).toBe('/u/config/zsh');
    expect(env[KILL_GUARD_USER_BASH_ENV_ENV]).toBe('/u/bash-env');
  });
});
