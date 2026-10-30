import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { WorkflowChangeSource } from '../graphs.types';

/**
 * One write to a library workflow that geniro made on someone's say-so — an
 * analysis's applied recommendations, an approved proposal card, a version
 * restore — with the versions it moved between and why. Keyed by slug, never
 * by run: it outlives the chat that made it, which is what lets a later
 * analysis see what was changed before, by whom and for what reason.
 */
@Entity({ tableName: 'workflow_change_log' })
@Index({ properties: ['slug', 'changedAt'] })
export class WorkflowChangeLogEntry extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  slug!: string;

  @Property({ type: DateTimeType })
  changedAt!: Date;

  @Property({ type: 'string' })
  source!: WorkflowChangeSource;

  /** The graph version replaced (`workflowVersionOf`); null when the write created the workflow. */
  @Property({ type: 'string', nullable: true })
  fromVersion: string | null = null;

  @Property({ type: 'string' })
  toVersion!: string;

  @Property({ type: 'text', nullable: true })
  summary: string | null = null;

  @Property({ type: 'text', nullable: true })
  reason: string | null = null;

  /** What the user typed on the card they approved. */
  @Property({ type: 'text', nullable: true })
  userNote: string | null = null;

  /** JSON array of the recommendation ids (`W-2`) the write carried out. */
  @Property({ type: 'text', nullable: true })
  recommendationIds: string | null = null;

  /** The analysis or chat that made the write; a plain copy, never a foreign key. */
  @Property({ type: 'string', nullable: true })
  chatRunId: string | null = null;

  /** The recommendations card an analysis's Apply named. */
  @Property({ type: 'integer', nullable: true })
  cardSeq: number | null = null;

  /** The backup taken of the replaced file, relative to the library. */
  @Property({ type: 'text', nullable: true })
  backup: string | null = null;
}
