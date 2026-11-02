import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type {
  ProjectInstructionChangeSource,
  ProjectInstructionField,
} from '../projects.types';

/**
 * One change to a project's description or instructions, with what it read
 * before and after and who made it — the user on the Projects page, or an
 * analysis carrying out applied `P-` recommendations. Exempt from run
 * teardown: it outlives the chat that made it, so a later analysis sees what
 * was changed before and why. Consecutive user edits of one field within
 * `PROJECT_CHANGE_COALESCE_MS` are kept as one row.
 */
@Entity({ tableName: 'project_instruction_changes' })
@Index({ properties: ['projectId', 'changedAt'] })
export class ProjectInstructionChange extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  projectId!: string;

  @Property({ type: DateTimeType })
  changedAt!: Date;

  @Property({ type: 'string' })
  field!: ProjectInstructionField;

  @Property({ type: 'string' })
  source!: ProjectInstructionChangeSource;

  @Property({ type: 'text', nullable: true })
  previous: string | null = null;

  @Property({ type: 'text', nullable: true })
  next: string | null = null;

  /** JSON array of the recommendation ids (`P-1`) an analysis carried out. */
  @Property({ type: 'text', nullable: true })
  recommendationIds: string | null = null;

  /** The analysis chat that made the change; a plain copy, never a foreign key. */
  @Property({ type: 'string', nullable: true })
  chatRunId: string | null = null;

  /** The recommendations card the Apply named. */
  @Property({ type: 'integer', nullable: true })
  cardSeq: number | null = null;
}
