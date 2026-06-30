import { Module } from '@nestjs/common';

import { NotificationsGateway } from './gateways/notifications.gateway';

/**
 * Owns the renderer ⇄ daemon Socket.IO channel. The gateway pulls the
 * per-launch token from the global {@link RuntimeModule}; M2 grows this module
 * with the run/item event emitters the renderer subscribes to.
 */
@Module({
  providers: [NotificationsGateway],
})
export class NotificationsModule {}
