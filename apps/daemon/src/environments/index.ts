import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dotenv from 'dotenv';

// Standalone/dev runs may keep overrides in apps/daemon/.env; under Electron the
// UI passes env vars directly, so a missing file is a silent no-op. Loaded
// before the factories below are CALLED (they read `process.env` at call time,
// not at import time), which is what makes a `.env` override take effect.
const appRoot = resolve(__dirname, '..', '..');
dotenv.config({ path: resolve(appRoot, '.env'), quiet: true, override: true });

import { environment as dev } from './environment.dev';
import { environment as prod } from './environment.prod';
import { environment as test } from './environment.test';

const ENV_MAP = {
  test: test(),
  development: dev(),
  production: prod(),
} as const;

const NODE_ENV = String(
  process.env.NODE_ENV || 'production',
) as keyof typeof ENV_MAP;

// `?? prod()` where the sibling casts and trusts: NODE_ENV is whatever the
// launching shell had, and an unrecognised value ('staging', a typo) would
// otherwise make every field `undefined` — a daemon that boots and then fails
// at its first `environment.userDataDir` read.
export const environment = ENV_MAP[NODE_ENV] ?? prod();

// The one side effect: ensure the userData dir exists before the ORM opens the
// SQLite file or the pidfile is written. Kept here (not in the env factories) so
// the environment objects stay pure.
mkdirSync(environment.userDataDir, { recursive: true });
