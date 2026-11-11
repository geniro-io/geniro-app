import { Entity, PrimaryKey } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * A run whose memory use from before the usage ledger existed has been counted
 * (`MemoryUsageBackfillService`), at `createdAt`. Written in the same
 * transaction as that run's counts, so a pass killed mid-way never counts a
 * run twice.
 */
@Entity({ tableName: 'memory_usage_backfill' })
export class MemoryUsageBackfill extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;
}
