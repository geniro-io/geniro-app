import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ProcessRegistry } from '../agents/services/process-registry';
import { GraphsModule } from '../graphs/graphs.module';
import { TerminalsController } from './controllers/terminals.controller';
import { TerminalsGateway } from './gateways/terminals.gateway';
import { PtyService } from './services/pty.service';
import { TerminalsService } from './services/terminals.service';

/**
 * Live PTY terminal mirror (M4): node-pty sessions that resume an agent's CLI
 * session as its original interactive TUI, bridged raw to xterm.js over the
 * `/terminals` Socket.IO namespace. Sessions are ephemeral (in-memory only —
 * a live mirror is not history); every PTY child registers with the shared
 * ProcessRegistry so cancel/shutdown reap it. PtyService is provided via a
 * factory because its options bag is a test seam, not a DI token.
 */
@Module({
  imports: [AgentsModule, GraphsModule],
  controllers: [TerminalsController],
  providers: [
    {
      provide: PtyService,
      useFactory: (registry: ProcessRegistry) => new PtyService(registry),
      inject: [ProcessRegistry],
    },
    TerminalsService,
    TerminalsGateway,
  ],
})
export class TerminalsModule {}
