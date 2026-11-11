import { Module } from '@nestjs/common';

import { BrowserBridgeService } from './services/browser-bridge.service';
import { BrowserHostApprovals } from './services/browser-host-approvals.service';

/**
 * The line from the agents' browser tools to the Mac's in-app browser
 * (`v1/browser`): the bridge to the one desktop window that hosts it, and what
 * the user approved per chat.
 *
 * It imports nothing from `v1/agents`, `v1/mcp` or `v1/teams`, so `AgentsModule`,
 * `McpModule` and `NotificationsModule` can import it without a cycle.
 */
@Module({
  providers: [BrowserBridgeService, BrowserHostApprovals],
  exports: [BrowserBridgeService, BrowserHostApprovals],
})
export class BrowserModule {}
