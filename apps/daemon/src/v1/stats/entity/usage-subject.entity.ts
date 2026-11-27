import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { UsageSubjectKind } from '../stats.types';

/**
 * A tool or capability that exists in this build: Geniro's own MCP tools and
 * the capability catalog, upserted at every boot. One whose `lastKnownAt` is
 * older than the current boot was retired and is no longer reported as never
 * called.
 */
@Entity({ tableName: 'usage_subjects' })
export class UsageSubject extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  subjectKind!: UsageSubjectKind;

  @PrimaryKey({ type: 'string' })
  subject!: string;

  @PrimaryKey({ type: 'string' })
  source!: string;

  /** Epoch ms of the first boot that knew it; never moved. */
  @Property({ type: 'integer' })
  firstKnownAt!: number;

  @Property({ type: 'integer' })
  lastKnownAt!: number;
}
