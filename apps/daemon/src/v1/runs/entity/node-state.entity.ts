import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind, NodeStatus } from '../runs.types';

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

  /**
   * The CLI that actually ran this node's turn, stamped at turn start. Run
   * history must not depend on the live workflow YAML: editing a node's agent
   * after runs exist would otherwise make the terminal mirror resume a past
   * session with the wrong CLI. Null on pre-existing rows (legacy fallback:
   * the YAML lookup).
   */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'integer', nullable: true })
  startedAt: number | null = null;

  @Property({ type: 'integer', nullable: true })
  endedAt: number | null = null;

  @Property({ type: 'text', nullable: true })
  error: string | null = null;
}
