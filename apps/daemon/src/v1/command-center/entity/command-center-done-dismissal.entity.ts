import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * How far the user dismissed one thread's finish, on every device: every Done
 * row announcing `runId` at or below `throughSeq` draws nothing in the manager
 * chat, and the gallery's card of the finish `finishKey` names is gone, so the
 * thread's next finish arrives as a new card. One row per manager and thread;
 * deleted with its manager.
 */
@Entity({ tableName: 'command_center_done_dismissals' })
export class CommandCenterDoneDismissal extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string', index: true })
  managerRunId!: string;

  @Property({ type: 'string' })
  runId!: string;

  @Property({ type: 'integer' })
  throughSeq!: number;

  /** The board's `finishKey` of the finish dismissed; null when the thread was not on the board. */
  @Property({ type: 'string', nullable: true })
  finishKey: string | null = null;

  @Property({ type: DateTimeType })
  dismissedAt!: Date;
}
