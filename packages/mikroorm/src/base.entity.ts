import { Filter, Property } from '@mikro-orm/decorators/legacy';

@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
export abstract class TimestampsEntity {
  @Property({ type: 'datetime' })
  createdAt: Date = new Date();

  @Property({ type: 'datetime', onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  deletedAt: Date | null = null;
}
