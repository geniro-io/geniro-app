import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { NotificationsGateway } from './gateways/notifications.gateway';

/**
 * Owns the renderer ⇄ daemon Socket.IO channel. The gateway pulls the
 * per-launch token from the global {@link RuntimeModule} and subscribes to the
 * {@link AgentEventBus} (imported from {@link AgentsModule}) to fan run items
 * out to per-run rooms.
 */
@Module({
  imports: [AgentsModule],
  providers: [NotificationsGateway],
})
export class NotificationsModule {}
