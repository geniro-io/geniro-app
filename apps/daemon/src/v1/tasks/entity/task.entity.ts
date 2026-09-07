import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { TaskPriority, TaskSource, TaskStatus } from '../tasks.types';

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

  /**
   * The folder this card's agent works in — null to take the project's.
   *
   * A project's folder is the DEFAULT and not the law: one board routinely
   * holds work across several checkouts, and before this column a card could
   * only ever run where its project pointed. Null means INHERIT rather than
   * "none", so moving a project's folder moves every card that never named one
   * of its own — which is what makes the project's field a default at all. A
   * snapshot taken at create would freeze it and quietly turn the project's
   * setting into a one-time seed.
   *
   * Canonicalized and checked to exist when it is SET (`TasksService`), on
   * `Project.folder`'s own rule: a card pointing at a folder that is not there
   * could never run, and the failure would surface as a worktree that cannot
   * be cut, minutes later and one process away.
   */
  @Property({ type: 'text', nullable: true })
  folder: string | null = null;

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
   * Order within the column, ascending. Neither contiguous nor monotonic over
   * time: a delete and a move-out each leave a hole nothing renumbers, and
   * deleting the LAST card frees a number the next one is given again.
   *
   * Unique within a column so long as positions are allocated one at a time,
   * which is what `TaskDao.nextPositionIn` buys by appending past the current
   * maximum instead of counting the live rows. Two allocations in a single
   * tick would still collide — no unique index backs this — so a caller that
   * fans several creates or moves out at once needs a conditional write
   * rather than this contract.
   *
   * `RunGroup.position` is NOT the stronger precedent it looks like: its
   * create is count-based too, and its own contract is that a reorder repairs
   * whatever shared a position, which this module has no route to do.
   */
  @Property({ type: 'integer' })
  position: number = 0;

  @Property({ type: 'string' })
  priority: TaskPriority = 'none';

  /**
   * The day this task is due, `YYYY-MM-DD`, or null.
   *
   * A DATE string and not a `Date` column: a due date is a day in the reader's
   * own life, so an instant would pin it to whichever zone wrote it and move it
   * a day for everyone else. Nothing compares it to a clock — the board
   * compares it to today, which is also a local idea.
   */
  @Property({ type: 'string', nullable: true })
  dueDate: string | null = null;
}
