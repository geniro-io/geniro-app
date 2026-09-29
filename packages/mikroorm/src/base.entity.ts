import { DateTimeType } from '@mikro-orm/core';
import { Filter, Property } from '@mikro-orm/decorators/legacy';

/**
 * Dates are declared with the `DateTimeType` CLASS, never the `'datetime'`
 * string. Both store the same integer column, but under MikroORM 7 on SQLite
 * the string form keeps its change-tracking snapshot as an ISO string while
 * the value it compares against is the stored number — so EVERY loaded entity
 * read as modified, and any flush of the EntityManager holding it wrote it back
 * with `onUpdate` stamping `updatedAt` to now. A read that happened to share a
 * fork with an unrelated write re-dated rows it never touched (measured: a run
 * loaded and flushed unchanged came back with today's `updatedAt`). The class
 * form hydrates and snapshots through the same conversion, so an untouched
 * entity is clean.
 */
@Filter({ name: 'softDelete', cond: { deletedAt: null }, default: true })
export abstract class TimestampsEntity {
  @Property({ type: DateTimeType })
  createdAt: Date = new Date();

  @Property({ type: DateTimeType, onUpdate: () => new Date() })
  updatedAt: Date = new Date();

  @Property({ type: DateTimeType, nullable: true })
  deletedAt: Date | null = null;
}
