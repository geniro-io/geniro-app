import { type DynamicModule, Global, Module } from '@nestjs/common';

import { RUNTIME_TOKEN, type RuntimeInfo } from './runtime';

/**
 * Exposes the per-launch {@link RuntimeInfo} (loopback token, version,
 * startedAt) app-wide. Global so any feature module — the HTTP token guard, the
 * notifications gateway — can inject `RUNTIME_TOKEN` without re-declaring it.
 * The value is minted in `main.ts` and handed in via `forRoot`.
 */
@Global()
@Module({})
export class RuntimeModule {
  static forRoot(runtime: RuntimeInfo): DynamicModule {
    const provider = { provide: RUNTIME_TOKEN, useValue: runtime };
    return {
      module: RuntimeModule,
      providers: [provider],
      exports: [provider],
    };
  }
}
