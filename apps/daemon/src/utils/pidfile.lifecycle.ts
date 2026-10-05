import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { environment } from '../environments';
import { AgentSessionRegistry } from '../v1/agents/services/agent-session.registry';
import { ProcessRegistry } from '../v1/agents/services/process-registry';
import { removePidfile } from './pidfile';

/**
 * Removes the pidfile when the daemon shuts down.
 *
 * Nest's shutdown hooks (enabled in `buildHttpNestApp` via
 * `app.enableShutdownHooks()`) fire `onApplicationShutdown` on SIGTERM/SIGINT,
 * so a stale pidfile never outlives the process — without reintroducing manual
 * signal handling in `main.ts` (Geniro's apps/api has none; the daemon stays
 * faithful to that shape and lets Nest own graceful shutdown).
 *
 * Only once every in-flight turn is drained and every kept agent process
 * signalled: the pidfile is how the app finds a running daemon, and removing
 * it first lets a new launch start beside this daemon's agent children.
 */
@Injectable()
export class PidfileLifecycle implements OnApplicationShutdown {
  constructor(
    private readonly processes: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Started, closed, THEN awaited: closing the kept processes in the same
    // tick the drain starts is what keeps a graceful quit from waiting out the
    // whole drain window, and keeps the close listeners suppressed.
    const drained = this.processes.drain();
    this.sessions.closeAll();
    await drained;
    removePidfile(environment.pidfilePath);
  }
}
