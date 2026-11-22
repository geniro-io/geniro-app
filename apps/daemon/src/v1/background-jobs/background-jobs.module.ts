import { Module } from '@nestjs/common';

import { BackgroundJobsController } from './controllers/background-jobs.controller';
import { BackgroundJobsRegistry } from './services/background-jobs.registry';

/**
 * Background jobs (`v1/background-jobs`): one list of the work geniro does on
 * the user's behalf off any thread's turn. It imports nothing: each kind's
 * module imports this one and registers its source, and the notifications
 * gateway observes the registry for `background_jobs_changed`.
 */
@Module({
  controllers: [BackgroundJobsController],
  providers: [BackgroundJobsRegistry],
  exports: [BackgroundJobsRegistry],
})
export class BackgroundJobsModule {}
