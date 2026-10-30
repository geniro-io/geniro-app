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

import type { WorkflowRecommendationChat } from '../stats.types';

/**
 * One item of a recommendations card filed about a library workflow — by its
 * analysis or its builder chat — with what became of it: selected in an Apply,
 * then marked applied, skipped or failed. Copied from the chat's rows, which a
 * new analysis deletes with the chat it replaces; this copy is what lets the
 * next analysis see what was recommended before and how it went. Never written
 * by run teardown.
 */
@Entity({ tableName: 'workflow_recommendations' })
@Unique({ properties: ['chatRunId', 'cardSeq', 'itemId'] })
@Index({ properties: ['slug', 'filedAt'] })
export class WorkflowRecommendation extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  slug!: string;

  /** The analysis or builder chat that filed the card; a plain copy, never a foreign key. */
  @Property({ type: 'string' })
  chatRunId!: string;

  @Property({ type: 'string' })
  chatKind!: WorkflowRecommendationChat;

  @Property({ type: 'integer' })
  cardSeq!: number;

  /** The card row's own time. */
  @Property({ type: DateTimeType })
  filedAt!: Date;

  /** The library's graph version when the card was filed; null when it was not read then. */
  @Property({ type: 'string', nullable: true })
  libraryVersion: string | null = null;

  @Property({ type: 'string' })
  itemId!: string;

  @Property({ type: 'string' })
  target!: string;

  @Property({ type: 'string' })
  territory!: string;

  @Property({ type: 'string' })
  kind!: string;

  @Property({ type: 'text' })
  location!: string;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  change!: string;

  @Property({ type: 'text' })
  rootCause!: string;

  @Property({ type: 'float' })
  minutesSaved!: number;

  @Property({ type: 'integer' })
  confidence!: number;

  @Property({ type: 'string' })
  risk!: string;

  /** When the user first selected it in an Apply; null while never selected. */
  @Property({ type: DateTimeType, nullable: true })
  selectedAt: Date | null = null;

  /** applied, skipped or failed, as the chat marked it; null while unmarked. */
  @Property({ type: 'string', nullable: true })
  outcome: string | null = null;

  @Property({ type: 'text', nullable: true })
  outcomeNote: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  outcomeAt: Date | null = null;

  /** The marking row's seq: a later mark replaces an earlier one, never the reverse. */
  @Property({ type: 'integer', nullable: true })
  outcomeSeq: number | null = null;
}
