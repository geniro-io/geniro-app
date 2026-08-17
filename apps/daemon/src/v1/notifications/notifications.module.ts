import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { DiagnosticsModule } from '../diagnostics/diagnostics.module';
import { StatsModule } from '../stats/stats.module';
import { NotificationsGateway } from './gateways/notifications.gateway';
import { WsPresenceService } from './services/ws-presence.service';

/**
 * Owns the renderer ⇄ daemon Socket.IO channel. The gateway pulls the
 * per-launch token from the global {@link RuntimeModule} and subscribes to the
 * {@link AgentEventBus} (imported from {@link AgentsModule}) to fan run items
 * out to per-run rooms.
 */
@Module({
  // `DiagnosticsModule` for the debug stream this gateway fans out. The
  // direction matters: diagnostics observes the agent plane and this channel
  // observes diagnostics, so nothing under `v1/agents` or `v1/diagnostics`
  // depends on the gateway and there is no cycle.
  // `StatsModule` for the usage bus, on the same terms as `DiagnosticsModule`:
  // stats observes the agent plane, this channel observes stats, and nothing
  // under either depends on the gateway — so there is still no cycle.
  imports: [AgentsModule, DiagnosticsModule, StatsModule],
  providers: [NotificationsGateway, WsPresenceService],
  // Exported for the idle shutdown: "is anyone connected?" is a fact only this
  // channel holds, and the decision to exit on it belongs elsewhere.
  exports: [WsPresenceService],
})
export class NotificationsModule {}
