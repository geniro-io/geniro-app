import { getEnv, type LogLevel } from '@packages/common';

import { environment as devEnvironment } from './environment.dev';

/**
 * Test-only environment defaults, loaded when `NODE_ENV=test` (vitest sets it).
 *
 * `devEnvironment()` is spread first — the same layering the sibling api uses,
 * and for the same reason: fields not named here inherit the DEV shape, so a
 * field added to dev never breaks tests. Explicit overrides come after.
 *
 * The logging pair IS named, rather than inherited: dev's pretty debug output
 * would put the daemon's whole log stream into the unit-test report, where it
 * buries the assertions it is interleaved with.
 *
 * Nothing else needs overriding, and that is a property of a local-first
 * daemon rather than an omission — there is no cloud backend a stray test
 * could dial. The one shared resource, the userData dir, is redirected by the
 * specs that touch it (each builds its own temp dir), never by this file.
 */
export const environment = () =>
  ({
    ...devEnvironment(),
    env: getEnv('NODE_ENV', 'test'),
    logLevel: getEnv('LOG_LEVEL', 'info') as LogLevel,
    prettyLog: getEnv('PRETTY_LOGS', false),
  }) as const satisfies Record<string, string | number | boolean | null>;
