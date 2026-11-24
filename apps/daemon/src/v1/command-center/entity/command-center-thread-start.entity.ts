import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

/**
 * A thread the command center's manager asked to start with no board card
 * (`start_thread` without `card`): put to the user on a Start card, then
 * started by Electron main's drain in the project's folder. Kept after it
 * started, failed or was declined, so its Start card can read how it ended;
 * deleted with its manager.
 */
@Entity({ tableName: 'command_center_thread_starts' })
export class CommandCenterThreadStart extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string', index: true })
  managerRunId!: string;

  @Property({ type: 'string' })
  projectId!: string;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  brief!: string;

  @Property({ type: 'string', nullable: true })
  agentKind: string | null = null;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  /** The manager's note on the thread, kept on its roster once it starts. */
  @Property({ type: 'text', nullable: true })
  note: string | null = null;

  @Property({ type: 'boolean', default: false })
  watch: boolean = false;

  @Property({ type: DateTimeType })
  requestedAt!: Date;

  @Property({ type: DateTimeType, nullable: true })
  approvedAt: Date | null = null;

  @Property({ type: DateTimeType, nullable: true })
  declinedAt: Date | null = null;

  /** The drain claimed it and is starting its run. */
  @Property({ type: DateTimeType, nullable: true })
  startingAt: Date | null = null;

  @Property({ type: 'string', nullable: true })
  runId: string | null = null;

  /** The manager heard it started and the thread joined its roster. */
  @Property({ type: DateTimeType, nullable: true })
  reportedAt: Date | null = null;

  @Property({ type: DateTimeType, nullable: true })
  failedAt: Date | null = null;

  @Property({ type: 'text', nullable: true })
  failure: string | null = null;
}
