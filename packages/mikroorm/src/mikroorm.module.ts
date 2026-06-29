import type { MikroOrmModuleSyncOptions } from '@mikro-orm/nestjs';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import type { IAppBootstrapperExtension } from '@packages/common';

export const buildMikroOrmExtension = (
  options: MikroOrmModuleSyncOptions,
): IAppBootstrapperExtension => ({
  modules: [MikroOrmModule.forRoot(options)],
});
