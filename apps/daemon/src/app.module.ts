import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RUNTIME_TOKEN, type RuntimeInfo } from './auth/runtime';
import { LoopbackTokenGuard } from './auth/token.guard';
import { RunsModule } from './v1/runs/runs.module';

export interface AppModuleOptions {
  runtime: RuntimeInfo;
}

/**
 * The daemon's domain module. Infra (HTTP server, mikro-orm, metrics, logger)
 * is wired via bootstrapper extensions in main.ts — mirroring how Geniro's
 * apps/api keeps AppModule free of infra imports. M1 wires the loopback token
 * guard + the runtime it reads and registers the runs domain (`v1/runs`); M2/M3
 * add agent/graph feature modules under `v1/` alongside it.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [RunsModule],
      providers: [
        { provide: RUNTIME_TOKEN, useValue: options.runtime },
        { provide: APP_GUARD, useClass: LoopbackTokenGuard },
      ],
    };
  }
}
