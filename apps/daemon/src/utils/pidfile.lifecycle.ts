import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { environment } from '../environments';
import { removePidfile } from './pidfile';

/**
 * Removes the pidfile when the daemon shuts down.
 *
 * Nest's shutdown hooks (enabled in `buildHttpNestApp` via
 * `app.enableShutdownHooks()`) fire `onApplicationShutdown` on SIGTERM/SIGINT,
 * so a stale pidfile never outlives the process — without reintroducing manual
 * signal handling in `main.ts` (Geniro's apps/api has none; the daemon stays
 * faithful to that shape and lets Nest own graceful shutdown).
 */
@Injectable()
export class PidfileLifecycle implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    removePidfile(environment.pidfilePath);
  }
}
