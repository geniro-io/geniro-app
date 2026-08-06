import { homedir } from 'node:os';
import { join } from 'node:path';

import { getEnv, type LogLevel } from '@packages/common';

import { DAEMON_VERSION } from '../utils/daemon-version';
import {
  DAEMON_HOST,
  DAEMON_PIDFILE_NAME,
  DAEMON_PREFERRED_PORT,
  parseDurationMs,
  parsePort,
} from '../utils/handshake';

/**
 * Base (production) environment, laid out like the sibling api's
 * (`geniro/apps/api/src/environments`): one object literal per env, prod as the
 * base, and the SHAPE INFERRED from it — there is no hand-written interface to
 * keep in step with the object, and a field added below is typed everywhere it
 * is read without a second edit.
 *
 * Three fields deliberately do NOT go through `getEnv`, and each says why at
 * its own line: that helper boolean-coerces `'0'`/`'1'`/`'on'`/`'off'`, which
 * is wrong for a path, a port and a duration alike. Their strict parsers live
 * in `utils/handshake.ts` beside the rest of the UI→daemon contract, so this
 * file holds environments and nothing else.
 */
export const environment = () => {
  // Read once: three fields below are derived from it.
  //
  // NOT `getEnv`: a userData path of "0" or "on" would come back as a boolean.
  // The Electron UI passes its own userData path; standalone/dev runs fall back
  // to `~/.geniro`.
  const userDataDir =
    process.env.GENIRO_USER_DATA?.trim() || join(homedir(), '.geniro');

  return {
    env: getEnv('NODE_ENV', 'production'),
    appName: 'geniro-daemon',
    version: DAEMON_VERSION,

    // server
    //
    // `host` is a CONSTANT, not an env knob, and that is the one place this
    // file deliberately parts from the sibling's env-everything shape: "the
    // daemon binds 127.0.0.1 only, never a routable address" is a hard v1
    // constraint, and an env var is exactly how it would come to be broken.
    host: DAEMON_HOST,
    // NOT `getEnv`: a port must be a bindable integer, so `'4e4'`, `'0x1234'`
    // and `'99999999'` are rejected rather than silently coerced into some
    // other port. A malformed value falls back to the default.
    preferredPort: parsePort(process.env.GENIRO_PORT) ?? DAEMON_PREFERRED_PORT,

    // storage (all under the userData dir the UI hands us)
    userDataDir,
    dbPath: join(userDataDir, 'geniro.db'),
    pidfilePath: join(userDataDir, DAEMON_PIDFILE_NAME),

    // lifecycle
    //
    // How long the daemon may sit with no connected client and no in-flight
    // turn before exiting itself; null = never, which is the DEFAULT. Only the
    // Electron supervisor sets it, because only it can promise a UI is the
    // sole client — `pnpm daemon:dev` and the throwaway `pnpm generate:api`
    // daemon have no client by design and must stay up regardless.
    idleExitMs: parseDurationMs(process.env.GENIRO_IDLE_EXIT_MS),

    // logging
    logLevel: getEnv('LOG_LEVEL', 'info') as LogLevel,
    prettyLog: getEnv('PRETTY_LOGS', false),
  } as const satisfies Record<string, string | number | boolean | null>;
};
