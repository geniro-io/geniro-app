import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { CliAuthController } from './controllers/cli-auth.controller';
import { CliAuthService } from './services/cli-auth.service';

/**
 * Signing a CLI in and out in place, so the ordinary case opens no terminal
 * window.
 *
 * Its own module rather than a second service inside `HandoffModule`, because the
 * two make opposite promises about the same commands: handoff RESOLVES an
 * invocation and never runs one — a property its doc blocks state and its specs
 * pin — while this one spawns and manages children. Folding them together would
 * make that promise conditional, which is how it stops being checkable.
 *
 * Imports `AgentsModule` for the adapter registry and the `ProcessRegistry`: an
 * abandoned sign-in is a detached group with a browser opener beneath it, so it
 * has to be reachable by shutdown like any other child this daemon spawns.
 */
@Module({
  imports: [AgentsModule],
  controllers: [CliAuthController],
  providers: [CliAuthService],
})
export class AuthModule {}
