import type { AnyEntity } from '@mikro-orm/core';
import type { EntityName } from '@mikro-orm/nestjs';
import { MikroOrmModule } from '@mikro-orm/nestjs';

export const registerEntities = (entities: EntityName<AnyEntity>[]) =>
  MikroOrmModule.forFeature(entities);
