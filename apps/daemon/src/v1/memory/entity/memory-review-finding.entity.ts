import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import type { MemoryCheckOutcome } from '../memory.types';

/**
 * What one model check said about a pair of shared-memory entries, at the
 * texts it read. One row per pair, `memoryAId` < `memoryBId`: a later check of
 * the same pair replaces it. The hashes pin the texts judged — `rev` also moves
 * on a forget or a restore, which leaves the text as it was — so a pair is
 * asked again, and a finding shown again, only once either text changes.
 * Outside run teardown, like the entries it names.
 */
@Entity({ tableName: 'memory_review_findings' })
@Unique({ properties: ['memoryAId', 'memoryBId'] })
export class MemoryReviewFinding extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string', fieldName: 'memory_a_id' })
  memoryAId!: string;

  @Property({ type: 'string', fieldName: 'memory_b_id' })
  memoryBId!: string;

  @Property({ type: 'string' })
  hashA!: string;

  @Property({ type: 'string' })
  hashB!: string;

  @Property({ type: 'string' })
  outcome!: MemoryCheckOutcome;

  @Property({ type: 'text', nullable: true })
  quoteA: string | null = null;

  @Property({ type: 'text', nullable: true })
  quoteB: string | null = null;

  @Property({ type: 'text', nullable: true })
  reason: string | null = null;

  @Property({ type: 'string' })
  agentKind!: AgentKind;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: DateTimeType })
  checkedAt!: Date;

  /** Set when the user said both entries are true; cleared by a check of new texts. */
  @Property({ type: DateTimeType, nullable: true })
  dismissedAt: Date | null = null;
}
