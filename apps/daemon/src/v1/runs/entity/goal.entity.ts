import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { GoalSource, GoalStatus } from '../../agents/chat.types';

/**
 * One goal of a run's task, recorded by the `goals` tool or by the user, and
 * closed with the evidence of how it ended.
 *
 * Exempt from `RunTeardownService`, like the usage ledgers: what a team
 * achieved is counted over every run it ever had, deleted ones included. So
 * `runId` is a plain string with no foreign key, and the team is stamped at
 * write time.
 */
@Entity({ tableName: 'run_goals' })
@Unique({ properties: ['runId', 'number'] })
@Index({ properties: ['teamSlug', 'createdAt'] })
export class Goal extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  /** The goal's place in its run, `g<number>` on the wire. */
  @Property({ type: 'integer' })
  number!: number;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  @Property({ type: 'text' })
  text!: string;

  @Property({ type: 'string' })
  source!: GoalSource;

  @Property({ type: 'string' })
  status!: GoalStatus;

  @Property({ type: 'text', nullable: true })
  evidence: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  closedAt: Date | null = null;
}
