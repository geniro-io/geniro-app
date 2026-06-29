import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { RUNTIME_TOKEN, type RuntimeInfo } from './runtime';
import { LoopbackTokenGuard } from './token.guard';

export interface AppModuleOptions {
  runtime: RuntimeInfo;
}

/**
 * The daemon's domain module. Infra (HTTP server, mikro-orm, metrics, logger)
 * is wired via bootstrapper extensions in main.ts — mirroring how Geniro's
 * apps/api keeps AppModule free of infra imports. M1 only provides the loopback
 * token guard + the runtime it reads; M2/M3 add agent/graph providers here.
 */
@Module({})
export class AppModule {
  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      providers: [
        { provide: RUNTIME_TOKEN, useValue: options.runtime },
        { provide: APP_GUARD, useClass: LoopbackTokenGuard },
      ],
    };
  }
}
