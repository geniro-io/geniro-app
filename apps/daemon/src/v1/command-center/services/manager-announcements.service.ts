import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { itemToWire } from '../../agents/utils/item-wire';
import { announcedIn, type ManagerAnnounced } from '../utils/manager-announced';

/**
 * What the manager chat has already been told — finished threads and waiting
 * items — read from its own host rows once per manager and kept, so a caller
 * adds what it announces before writing the row.
 */
@Injectable()
export class ManagerAnnouncementsService {
  private held: {
    managerRunId: string;
    announced: Promise<ManagerAnnounced>;
  } | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
  ) {}

  of(managerRunId: string): Promise<ManagerAnnounced> {
    if (this.held?.managerRunId !== managerRunId) {
      const announced = this.itemDao
        .rowsOfKinds(managerRunId, ['system'], undefined, this.em.fork())
        .then((rows) =>
          announcedIn(rows.map((row) => itemToWire(row).payload)),
        );
      this.held = { managerRunId, announced };
      announced.catch(() => {
        if (this.held?.announced === announced) {
          this.held = null;
        }
      });
    }
    return this.held.announced;
  }
}
