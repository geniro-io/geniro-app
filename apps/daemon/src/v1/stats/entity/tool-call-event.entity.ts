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

import type { AgentKind } from '../../runs/runs.types';

/**
 * One finished tool call of an agent — its own, never a sub-agent's — recorded to
 * OUTLIVE the run, like `UsageEvent`: append-only, never touched by run teardown, the
 * team and member stamped at write time. Narrow on purpose (one row per call), with no
 * arguments or output: what a tool and an MCP server are used for, how often they fail
 * and how long they take, is all it answers.
 */
@Entity({ tableName: 'tool_call_events' })
@Unique({ properties: ['runId', 'seq'] })
@Index({ properties: ['occurredAt'] })
@Index({ properties: ['teamSlug', 'occurredAt'] })
@Index({ properties: ['tool'] })
export class ToolCallEvent extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  /** The `tool_result` row that ended the call. */
  @Property({ type: 'integer' })
  seq!: number;

  @Property({ type: DateTimeType })
  occurredAt!: Date;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  /** The team member that called it; null for a chat's agent. */
  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /** The tool as its adapter names it for a count: an MCP tool without its server. */
  @Property({ type: 'string' })
  tool!: string;

  /** The MCP server the tool came from (`geniro` for this app's own); null for a CLI's own tool. */
  @Property({ type: 'string', nullable: true })
  mcpServer: string | null = null;

  @Property({ type: 'boolean' })
  ok!: boolean;

  /** From the call row to its result row; null when the call row was not found. */
  @Property({ type: 'integer', nullable: true })
  durationMs: number | null = null;
}
