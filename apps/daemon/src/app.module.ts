import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { type RuntimeInfo } from './auth/runtime';
import { RuntimeModule } from './auth/runtime.module';
import { LoopbackTokenGuard } from './auth/token.guard';
import { PidfileLifecycle } from './utils/pidfile.lifecycle';
import { NotificationsModule } from './v1/notifications/notifications.module';
import { RunsModule } from './v1/runs/runs.module';

export interface AppModuleOptions {
  runtime: RuntimeInfo;
}

/**
 * The daemon's domain module. Infra (HTTP server, mikro-orm, metrics, logger)
 * is wired via bootstrapper extensions in main.ts — mirroring how Geniro's
 * apps/api keeps AppModule free of infra imports. The per-launch runtime is
 * exposed app-wide via the global RuntimeModule (so the HTTP token guard and
 * the notifications gateway both read it); M1 registers the runs domain
 * (`v1/runs`) and the Socket.IO notifications channel (`v1/notifications`).
 * M2/M3 add agent/graph feature modules under `v1/` alongside them.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        RuntimeModule.forRoot(options.runtime),
        NotificationsModule,
        RunsModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: LoopbackTokenGuard },
        PidfileLifecycle,
      ],
    };
  }
}
