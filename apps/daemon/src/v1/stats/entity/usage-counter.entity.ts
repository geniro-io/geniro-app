import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { UsageOrigin, UsageSubjectKind } from '../stats.types';

/**
 * How often one tool, capability, skill or command was used, by one source,
 * agent, origin and project — counted for good, never per day.
 *
 * Written only by increments (`UsageCounterDao.add`), never by a
 * read-modify-write, and outside run teardown like every stats ledger. Every
 * key column is a non-null string (`''` for none) so the composite key holds.
 */
@Entity({ tableName: 'usage_counters' })
export class UsageCounter extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  subjectKind!: UsageSubjectKind;

  @PrimaryKey({ type: 'string' })
  subject!: string;

  /** The MCP server a tool came from (`geniro` for this app's own); `''` otherwise. */
  @PrimaryKey({ type: 'string' })
  source!: string;

  @PrimaryKey({ type: 'string' })
  agentKind!: string;

  @PrimaryKey({ type: 'string' })
  origin!: UsageOrigin;

  @PrimaryKey({ type: 'string' })
  projectId!: string;

  @Property({ type: 'integer' })
  calls!: number;

  @Property({ type: 'integer' })
  errors!: number;

  /** Refusals the daemon could attribute: a Geniro tool's served refusal, a denied permission request. */
  @Property({ type: 'integer' })
  refused!: number;

  @Property({ type: 'integer' })
  durationMsTotal!: number;

  @Property({ type: 'integer' })
  timedCalls!: number;

  @Property({ type: 'integer' })
  resultCharsTotal!: number;

  @Property({ type: 'integer' })
  sizedCalls!: number;

  /** CLI sessions a Geniro tool was listed to. */
  @Property({ type: 'integer' })
  offeredSessions!: number;

  /** Epoch ms of the first counted use; null while only offers are counted. */
  @Property({ type: 'integer', nullable: true })
  firstAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  lastAt: number | null = null;
}
