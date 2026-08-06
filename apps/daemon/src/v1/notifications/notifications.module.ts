import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { NotificationsGateway } from './gateways/notifications.gateway';
import { WsPresenceService } from './services/ws-presence.service';

/**
 * Owns the renderer ⇄ daemon Socket.IO channel. The gateway pulls the
 * per-launch token from the global {@link RuntimeModule} and subscribes to the
 * {@link AgentEventBus} (imported from {@link AgentsModule}) to fan run items
 * out to per-run rooms.
 */
@Module({
  imports: [AgentsModule],
  providers: [NotificationsGateway, WsPresenceService],
  // Exported for the idle shutdown: "is anyone connected?" is a fact only this
  // channel holds, and the decision to exit on it belongs elsewhere.
  exports: [WsPresenceService],
})
export class NotificationsModule {}
