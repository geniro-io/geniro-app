import { randomUUID } from 'node:crypto';

import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind } from '../../runs/runs.types';
import type { TaskSource, TaskStatus } from '../../tasks/tasks.types';
import { PROJECT_DEFAULT_MAX_CONCURRENT } from '../projects.types';

/**
 * A folder, and the standing answers for every task worked inside it.
 *
 * Deliberately NOT the chat sidebar's {@link RunGroup}, which it links to
 * instead: a group is a disposable arrangement of one user's sidebar, carrying
 * display state (position, collapsed), while a project carries folder identity,
 * run defaults and autopilot policy. Loading that onto every throwaway group
 * was the alternative, and it would make a folder the user made to tidy three
 * chats into a thing that can start agents.
 */
@Entity({ tableName: 'projects' })
export class Project extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'text' })
  name!: string;

  /** Absolute, and canonicalized by the service before it is stored. */
  @Property({ type: 'text' })
  folder!: string;

  /**
   * The sidebar group this project's task runs file themselves into. A plain
   * id with no FK, matching `Run.groupId`: deleting the group must release the
   * project rather than delete it, so this is nulled and never cascaded.
   */
  @Property({ type: 'string', nullable: true })
  groupId: string | null = null;

  // ── Run configuration ───────────────────────────────────────────────────
  // Null throughout, and null means "unset — use whatever the composer would
  // have". A project that has never been configured must not pin an agent or a
  // model the user never chose, so none of these carries a default.

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: 'string', nullable: true })
  effort: string | null = null;

  @Property({ type: 'string', nullable: true })
  approval: ChatApprovalMode | null = null;

  @Property({ type: 'text', nullable: true })
  configDir: string | null = null;

  /** A workflow to run a task through, instead of a single agent. */
  @Property({ type: 'string', nullable: true })
  workflowSlug: string | null = null;

  // ── Autopilot policy ────────────────────────────────────────────────────
  // Stored here from the start so the board and the conductor read one row
  // rather than two. Nothing in this milestone acts on any of it.

  @Property({ type: 'boolean' })
  autopilotEnabled: boolean = false;

  /**
   * The column the autopilot picks work up from. `todo` rather than `backlog`
   * so that switching autopilot on claims the work the user has actually
   * queued, not everything they have ever jotted down.
   */
  @Property({ type: 'string' })
  autopilotIntakeStatus: TaskStatus = 'todo';

  /**
   * How many of this project's tasks may run at once. One by default because
   * each running task takes its own git worktree — a second concurrent task is
   * a second working copy on disk, `node_modules` and all.
   */
  @Property({ type: 'integer' })
  autopilotMaxConcurrent: number = PROJECT_DEFAULT_MAX_CONCURRENT;

  /**
   * Consecutive failed autopilot runs. The breaker reads it to stop a project
   * that is failing every task it picks up; a success resets it to 0.
   */
  @Property({ type: 'integer' })
  autopilotFailureStreak: number = 0;

  /**
   * Where this project's tasks come from, and the value they carry as their
   * own `source`. One vocabulary rather than two that have to agree.
   */
  @Property({ type: 'string' })
  provider: TaskSource = 'geniro';
}
