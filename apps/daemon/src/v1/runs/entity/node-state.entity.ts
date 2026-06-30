import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { NodeStatus } from '../runs.types';

/** Per-node execution status within a run (composite PK: runId + nodeId). */
@Entity({ tableName: 'node_state' })
export class NodeState extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  runId!: string;

  @PrimaryKey({ type: 'string' })
  nodeId!: string;

  @Property({ type: 'string' })
  status: NodeStatus = 'pending';

  /** Underlying CLI session id, for resume/inspection (populated in M2). */
  @Property({ type: 'string', nullable: true })
  agentSessionId: string | null = null;

  @Property({ type: 'integer', nullable: true })
  startedAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endedAt: number | null = null;

  @Property({ type: 'text', nullable: true })
  error: string | null = null;
}
