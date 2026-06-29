import { randomUUID } from 'node:crypto';

import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';
import type { RunStatus } from '@packages/types';

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
}
