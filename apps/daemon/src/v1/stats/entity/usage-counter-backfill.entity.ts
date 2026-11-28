import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * The one-time fold of `tool_call_events` into the counters: rows that
 * occurred before `cutoff` are folded window by window after the cursor,
 * which is committed in the same transaction as each window's counts, so a
 * kill never folds a window twice.
 */
@Entity({ tableName: 'usage_counter_backfill' })
export class UsageCounterBackfill extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  source!: string;

  /** Epoch ms; rows at or after it are counted live. */
  @Property({ type: 'integer' })
  cutoff!: number;

  @Property({ type: 'integer', nullable: true })
  cursorOccurredAt: number | null = null;

  @Property({ type: 'string', nullable: true })
  cursorId: string | null = null;

  @Property({ type: 'integer', nullable: true })
  doneAt: number | null = null;
}
