import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { ProcessRegistry } from '../agents/services/process-registry';
import { runManagedCommand } from '../agents/utils/managed-command';
import { SharesController } from './controllers/shares.controller';
import { ArtifactShareDao } from './dao/artifact-share.dao';
import { ShareService } from './services/share.service';
import { ShareEventBus } from './services/share-events.bus';
import { ShareKeychain } from './services/share-keychain.service';
import { ShareSignInService } from './services/share-sign-in.service';
import { SHARE_COMMAND_RUNNER, type ShareCommandRunner } from './shares.types';

/**
 * Encrypted share links for artifacts (`v1/shares`).
 *
 * Its rows deliberately sit outside run teardown: a link outlives the chat it
 * came from, and this table is the only way to revoke it. Only a share never
 * uploaded (waiting on sign-in, or failed after it) goes with its run.
 */
@Module({
  imports: [AgentsModule],
  controllers: [SharesController],
  providers: [
    ArtifactShareDao,
    DesktopOnlyGuard,
    {
      provide: SHARE_COMMAND_RUNNER,
      useFactory:
        (processes: ProcessRegistry): ShareCommandRunner =>
        (command) =>
          runManagedCommand({ ...command, processes }),
      inject: [ProcessRegistry],
    },
    ShareKeychain,
    ShareService,
    ShareEventBus,
    ShareSignInService,
  ],
  exports: [ShareService, ShareEventBus],
})
export class SharesModule {}
