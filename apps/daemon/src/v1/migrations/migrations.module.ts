import { Module } from '@nestjs/common';

import { MigrationRunnerService } from './services/migration-runner.service';

/** The journaled migrations `main.ts` runs before the schema sync (`MigrationRunnerService`). */
@Module({
  providers: [MigrationRunnerService],
  exports: [MigrationRunnerService],
})
export class MigrationsModule {}
