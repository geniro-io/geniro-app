import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { ProjectsModule } from '../projects/projects.module';
import { PluginsController } from './controllers/plugins.controller';
import { PluginEventBus } from './services/plugin-events.bus';
import { PluginRunnerService } from './services/plugin-runner.service';
import { PluginStoreService } from './services/plugin-store.service';
import { PluginsService } from './services/plugins.service';

/**
 * User-made plugins (`v1/plugins`): recipe files in `<userData>/plugins/`,
 * their approved copies, and the runner that runs an approved command in a
 * thread's folder. It imports `AgentsModule` and `ProjectsModule`; nothing
 * in `v1/agents` imports it back — an approved card writes through
 * `PluginProposalBroker`, which this module supplies the writer of.
 */
@Module({
  imports: [AgentsModule, ProjectsModule],
  controllers: [PluginsController],
  providers: [
    PluginEventBus,
    {
      provide: PluginStoreService,
      useFactory: (events: PluginEventBus) =>
        new PluginStoreService({}, events),
      inject: [PluginEventBus],
    },
    PluginRunnerService,
    PluginsService,
  ],
  exports: [PluginStoreService, PluginEventBus, PluginRunnerService],
})
export class PluginsModule {}
