import { getEnv, type LogLevel } from '@packages/common';

import { environment as prodEnvironment } from './environment.prod';

/**
 * Development overrides. `prodEnvironment()` is spread first so anything not
 * named here inherits the prod shape — a field added to prod reaches dev with
 * no edit.
 */
export const environment = () =>
  ({
    ...prodEnvironment(),
    env: getEnv('NODE_ENV', 'development'),
    // Cast like prod's: `getEnv` answers `string`, and every variant has to
    // land on `LogLevel` or the union across them widens back to `string` and
    // stops satisfying the logger.
    logLevel: getEnv('LOG_LEVEL', 'debug') as LogLevel,
    prettyLog: getEnv('PRETTY_LOGS', true),
  }) as const satisfies Record<string, string | number | boolean | null>;
