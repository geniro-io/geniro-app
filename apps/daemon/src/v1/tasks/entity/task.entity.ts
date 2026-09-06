import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { TaskSource, TaskStatus } from '../tasks.types';

/**
 * One card on a project's board.
 *
 * A plain `projectId` column rather than a MikroORM relation, the same shape
 * `Run.groupId` uses: nothing in this daemon declares a relation or a cascade,
 * so the owning service removes a project's tasks explicitly and the database
 * is never asked to.
 */
@Entity({ tableName: 'tasks' })
// The board's own query: every card in one project, which is what the screen
// asks for on every open and after every move.
@Index({ properties: ['projectId'] })
// The autopilot's query, and the one that is NOT scoped by project: "is
// anything sitting in an intake column", asked across every project on each
// sweep. Without this it is a full scan of the table on a timer.
@Index({ properties: ['status'] })
export class Task extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  projectId!: string;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text', nullable: true })
  description: string | null = null;

  @Property({ type: 'string' })
  status: TaskStatus = 'backlog';

  /**
   * JSON-encoded `string[]`, like `Item.payload` — this daemon stores
   * structured values as text and decodes them at the service boundary, and a
   * label list is not something any query filters on in the database.
   */
  @Property({ type: 'text' })
  labels: string = '[]';

  @Property({ type: 'string' })
  source: TaskSource = 'geniro';

  /**
   * The id this task carries in the system it came from. Null for a task made
   * here: geniro's own primary key is already that id, and a copy of it would
   * be a second name for the same thing.
   */
  @Property({ type: 'string', nullable: true })
  sourceRef: string | null = null;

  /** The branch an agent works this task on — null until one runs. */
  @Property({ type: 'string', nullable: true })
  branch: string | null = null;

  /** The worktree that branch is checked out in — null until one runs. */
  @Property({ type: 'text', nullable: true })
  worktreePath: string | null = null;

  /**
   * The chat run currently serving this task. A plain id with no FK, matching
   * `Run.groupId`: a run deleted from the sidebar must not take the task with
   * it, so this is cleared rather than cascaded.
   */
  @Property({ type: 'string', nullable: true })
  runId: string | null = null;

  /**
   * The transcript item holding the agent's report, so the card can show that
   * a report is ready without replaying the run to find it.
   */
  @Property({ type: 'string', nullable: true })
  reportItemId: string | null = null;

  /**
   * Order within the column, ascending. Kept contiguous from 0 by every write
   * that reorders, the same contract `RunGroup.position` holds, so no gap can
   * accumulate into an ordering two open boards disagree about.
   */
  @Property({ type: 'integer' })
  position: number = 0;
}
