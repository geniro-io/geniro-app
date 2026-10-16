import { Module } from '@nestjs/common';

import { DesktopOnlyGuard } from '../../auth/desktop-only.guard';
import { AgentsModule } from '../agents/agents.module';
import { ProcessRegistry } from '../agents/services/process-registry';
import { runManagedCommand } from '../agents/utils/managed-command';
import { SharesController } from './controllers/shares.controller';
import { ArtifactShareDao } from './dao/artifact-share.dao';
import { ShareService } from './services/share.service';
import { ShareKeychain } from './services/share-keychain.service';
import { SHARE_COMMAND_RUNNER, type ShareCommandRunner } from './shares.types';

/**
 * Encrypted share links for artifacts (`v1/shares`).
 *
 * Its rows deliberately sit outside run teardown: a link outlives the chat it
 * came from, and this table is the only way to revoke it.
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
  ],
  exports: [ShareService],
})
export class SharesModule {}
