import { Injectable, type OnModuleInit } from '@nestjs/common';

import { AgentEventBus } from './agent-events.bus';
import { MonitorRegistry } from './monitor.registry';

/**
 * Tells clients the moment a run's set of running monitors changes, so run
 * state's `monitors` is re-read then: the row recording an end can wait for
 * the agent's turn to finish, while the monitor is already gone.
 */
@Injectable()
export class MonitorAnnouncer implements OnModuleInit {
  constructor(
    private readonly monitors: MonitorRegistry,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.monitors.subscribe((event) => {
      if (event.type === 'batch') {
        return;
      }
      this.bus.publishRunStatus({
        runId: event.monitor.owner.runId,
        status: null,
        monitorsChangedAt: Date.now(),
      });
    });
  }
}
