import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { mapEventToItem } from '../utils/event-to-item';
import { persistItemAndEmit } from '../utils/persist-item';
import { AgentEventBus } from './agent-events.bus';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';

/** Writes a run-level warning row for something geniro did outside any turn. */
@Injectable()
export class RunNoticeWriter {
  private readonly logger = new Logger(RunNoticeWriter.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
  ) {}

  /** Never throws; a deleted run gets no row. */
  async warn(runId: string, message: string, caption: string): Promise<void> {
    try {
      const em = this.em.fork();
      if ((await this.runDao.getById(runId, em)) === null) {
        return;
      }
      const row = mapEventToItem({
        type: 'notice',
        message,
        severity: 'warning',
        caption,
      })!;
      await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId,
          memberId: null,
          seq: await this.seqs.reserve(runId),
          kind: row.kind,
          role: row.role,
          payload: row.payload,
        },
      );
    } catch (err) {
      this.logger.error(
        `run ${runId} notice row failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
