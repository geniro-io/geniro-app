import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { GraphsModule } from '../graphs/graphs.module';
import { HandoffController } from './controllers/handoff.controller';
import { HandoffService } from './services/handoff.service';

/**
 * Handing a conversation to the user: resolve a run (or one workflow node) to
 * the CLI invocation that reopens ITS session, or to the reason that CLI
 * cannot. Stateless — no processes, no sockets, nothing to clean up.
 */
@Module({
  imports: [AgentsModule, GraphsModule],
  controllers: [HandoffController],
  providers: [HandoffService],
})
export class HandoffModule {}
