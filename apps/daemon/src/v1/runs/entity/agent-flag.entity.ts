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

import type {
  AgentFlagCategory,
  AgentFlagCost,
  AgentFlagRunKind,
} from '../../agents/chat.types';

/**
 * One problem an agent flagged with `flag_issue`: something that cost work, or
 * the user's disagreement — or one the daemon recorded itself (`automatic`).
 *
 * Exempt from `RunTeardownService`, like `run_goals`: every analysis reads the
 * flags of a period, deleted threads included. So `runId` is a plain string
 * with no foreign key, and the thread's kind, title, team and project are
 * stamped at write time.
 */
@Entity({ tableName: 'agent_flags' })
@Unique({ properties: ['handle'] })
@Unique({ properties: ['runId', 'autoCause'] })
@Index({ properties: ['occurredAt'] })
@Index({ properties: ['runId', 'seq'] })
export class AgentFlag extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** `F-<6 hex>`, what agents and reports cite. */
  @Property({ type: 'string' })
  handle!: string;

  @Property({ type: 'string' })
  runId!: string;

  /** The run's newest row when the flag was raised: what an analysis reads up to. */
  @Property({ type: 'integer' })
  seq!: number;

  @Property({ type: DateTimeType })
  occurredAt!: Date;

  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  /** The conversation that raised it, null for the member's own. */
  @Property({ type: 'string', nullable: true })
  conversationId: string | null = null;

  @Property({ type: 'string', nullable: true })
  callId: string | null = null;

  @Property({ type: 'string', nullable: true })
  agentKind: string | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'string' })
  runKind!: AgentFlagRunKind;

  @Property({ type: 'text', nullable: true })
  runTitle: string | null = null;

  @Property({ type: 'string' })
  cost!: AgentFlagCost;

  @Property({ type: 'string' })
  category!: AgentFlagCategory;

  @Property({ type: 'integer', nullable: true })
  minutesLost: number | null = null;

  @Property({ type: 'text' })
  summary!: string;

  @Property({ type: 'text', nullable: true })
  detail: string | null = null;

  @Property({ type: 'boolean', default: false })
  automatic: boolean = false;

  /** Why the daemon raised it; unique per run, so each cause flags a thread once. Null on an agent's flag. */
  @Property({ type: 'string', nullable: true })
  autoCause: string | null = null;
}
