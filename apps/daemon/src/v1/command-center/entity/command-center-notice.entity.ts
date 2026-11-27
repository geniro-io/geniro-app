import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { SettingsNoticeKind } from '../../agents/chat.types';

/**
 * One notice of something waiting on the user in Settings, announced once in
 * the command center's manager chat: open from its first reading until its
 * reason goes, at most one open per `key` and manager. `items` (a JSON array)
 * holds every item it has shown, so an item it already showed never reopens
 * it once dismissed. Deleted with its manager.
 */
@Entity({ tableName: 'command_center_notices' })
export class CommandCenterNotice extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string', index: true })
  managerRunId!: string;

  @Property({ type: 'string' })
  kind!: SettingsNoticeKind;

  @Property({ type: 'string' })
  key!: string;

  @Property({ type: 'text' })
  items!: string;

  @Property({ type: DateTimeType })
  openedAt!: Date;

  @Property({ type: DateTimeType, nullable: true })
  resolvedAt: Date | null = null;

  @Property({ type: DateTimeType, nullable: true })
  dismissedAt: Date | null = null;
}
