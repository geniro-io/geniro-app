import { type DynamicModule, Global, Module } from '@nestjs/common';

import { CallTokenRegistry } from './call-token.registry';
import { RUNTIME_TOKEN, type RuntimeInfo } from './runtime';

/**
 * Exposes the per-launch {@link RuntimeInfo} (loopback token, version,
 * startedAt) app-wide. Global so any feature module — the HTTP token guard, the
 * notifications gateway — can inject `RUNTIME_TOKEN` without re-declaring it.
 * The value is minted in `main.ts` and handed in via `forRoot`. Also hosts the
 * {@link CallTokenRegistry}: the guard (auth) reads it and the graph executor
 * (graphs) writes it, so it lives below both to avoid a module cycle.
 */
@Global()
@Module({})
export class RuntimeModule {
  static forRoot(runtime: RuntimeInfo): DynamicModule {
    const provider = { provide: RUNTIME_TOKEN, useValue: runtime };
    return {
      module: RuntimeModule,
      providers: [provider, CallTokenRegistry],
      exports: [provider, CallTokenRegistry],
    };
  }
}
