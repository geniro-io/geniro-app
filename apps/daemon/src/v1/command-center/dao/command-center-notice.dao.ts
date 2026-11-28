import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type { SettingsNoticeKind } from '../../agents/chat.types';
import { CommandCenterNotice } from '../entity/command-center-notice.entity';

/** `command_center_notices` — the manager chat's Settings notices. */
@Injectable()
export class CommandCenterNoticeDao extends BaseDao<CommandCenterNotice> {
  constructor(em: EntityManager) {
    super(em, CommandCenterNotice);
  }

  async open(fields: {
    id: string;
    managerRunId: string;
    kind: SettingsNoticeKind;
    key: string;
    items: readonly string[];
    label: string | null;
    openedAt: Date;
  }): Promise<CommandCenterNotice> {
    const em = this.em.fork();
    const row = this.getRepo(em).create(
      { ...fields, items: JSON.stringify(fields.items) },
      { partial: true },
    );
    await em.flush();
    return row;
  }

  /** Every notice of the manager, oldest first. */
  list(managerRunId: string): Promise<CommandCenterNotice[]> {
    return this.getRepo(this.em.fork()).find(
      { managerRunId },
      { orderBy: { openedAt: 'asc', id: 'asc' }, disableIdentityMap: true },
    );
  }

  /** The manager's notices whose reason still stands. */
  listOpen(managerRunId: string): Promise<CommandCenterNotice[]> {
    return this.getRepo(this.em.fork()).find(
      { managerRunId, resolvedAt: null },
      { orderBy: { openedAt: 'asc', id: 'asc' }, disableIdentityMap: true },
    );
  }

  read(id: string): Promise<CommandCenterNotice | null> {
    return this.getRepo(this.em.fork()).findOne(
      { id },
      { disableIdentityMap: true },
    );
  }

  async update(
    id: string,
    items: readonly string[],
    label: string | null,
  ): Promise<void> {
    await this.getRepo(this.em.fork()).nativeUpdate(
      { id },
      { items: JSON.stringify(items), label },
    );
  }

  async resolve(id: string, at: Date): Promise<void> {
    await this.getRepo(this.em.fork()).nativeUpdate(
      { id, resolvedAt: null },
      { resolvedAt: at },
    );
  }

  /** False when there is no such notice or it was dismissed already. */
  async dismiss(id: string, at: Date): Promise<boolean> {
    return (
      (await this.getRepo(this.em.fork()).nativeUpdate(
        { id, dismissedAt: null },
        { dismissedAt: at },
      )) === 1
    );
  }

  async deleteOf(managerRunId: string): Promise<void> {
    await this.getRepo(this.em.fork()).nativeDelete({ managerRunId });
  }
}
