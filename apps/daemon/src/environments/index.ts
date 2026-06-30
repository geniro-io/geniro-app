import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dotenv from 'dotenv';

import { environment as dev } from './environment.dev';
import { environment as prod } from './environment.prod';
import { environment as test } from './environment.test';

// Standalone/dev runs may keep overrides in apps/daemon/.env; under Electron the
// UI passes env vars directly, so a missing file is a silent no-op.
const appRoot = resolve(__dirname, '..', '..');
dotenv.config({ path: resolve(appRoot, '.env'), quiet: true, override: true });

const ENV_MAP = {
  test: test(),
  development: dev(),
  production: prod(),
} as const;

const NODE_ENV = String(
  process.env.NODE_ENV || 'production',
) as keyof typeof ENV_MAP;

export const environment = ENV_MAP[NODE_ENV] ?? prod();

// The one side effect: ensure the userData dir exists before the ORM opens the
// SQLite file or the pidfile is written. Kept here (not in the env factories) so
// the environment objects stay pure.
mkdirSync(environment.userDataDir, { recursive: true });

export { DAEMON_VERSION, type DaemonEnvironment } from './environment.prod';
