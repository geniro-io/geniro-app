import { randomUUID } from 'node:crypto';

import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind, RunStatus } from '../runs.types';

/** One execution of a workflow (graph) or a single-agent chat. */
@Entity({ tableName: 'runs' })
export class Run extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** Workflow (graph) id this run executed; null for an ad-hoc single agent. */
  @Property({ type: 'string', nullable: true })
  workflowId: string | null = null;

  @Property({ type: 'string' })
  status: RunStatus = 'pending';

  @Property({ type: 'string', nullable: true })
  title: string | null = null;

  /**
   * Working directory for a single-agent chat run — the user's chosen project
   * folder, which the adapter spawns the CLI in. Null for graph runs. The
   * daemon validates this path before spawning so the headless agent is scoped
   * to the user's project and never the daemon's own cwd (the app repo).
   */
  @Property({ type: 'string', nullable: true })
  cwd: string | null = null;

  /** Which CLI agent drives a single-agent chat run; null for graph runs. */
  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  /** Model alias for a single-agent run; null = adapter default. */
  @Property({ type: 'string', nullable: true })
  model: string | null = null;
}
