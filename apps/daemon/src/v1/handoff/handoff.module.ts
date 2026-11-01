import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { TeamsModule } from '../teams/teams.module';
import { HandoffController } from './controllers/handoff.controller';
import { HandoffService } from './services/handoff.service';

/**
 * Handing a conversation to the user: resolve a run (or one team node) to
 * the CLI invocation that reopens ITS session, or to the reason that CLI
 * cannot. Stateless — no processes, no sockets, nothing to clean up.
 */
@Module({
  imports: [AgentsModule, TeamsModule],
  controllers: [HandoffController],
  providers: [HandoffService],
})
export class HandoffModule {}
