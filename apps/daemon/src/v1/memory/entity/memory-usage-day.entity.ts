import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * How agents used one shared-memory entry on one UTC day — composite PK:
 * `memoryId` + `day` (`YYYY-MM-DD`).
 *
 * Written only by increments (`MemoryUsageDao.add`), never by a
 * read-modify-write, so concurrent counts all land. Outside run teardown, like
 * the entry it counts: deleting a chat leaves what its agents read counted.
 */
@Entity({ tableName: 'memory_usage_days' })
export class MemoryUsageDay extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  memoryId!: string;

  @PrimaryKey({ type: 'string' })
  day!: string;

  /** `memory_read` calls that returned the entry. */
  @Property({ type: 'integer' })
  reads!: number;

  /** `memory_search` results that listed the entry. */
  @Property({ type: 'integer' })
  searchHits!: number;

  /** Runs created with the entry in their memory index. */
  @Property({ type: 'integer' })
  indexShows!: number;
}
