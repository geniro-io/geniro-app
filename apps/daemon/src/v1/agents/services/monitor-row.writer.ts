import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { MonitorRowPayload } from '../chat.types';
import type { MonitorEvent, MonitorOwner } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  type MonitorMessage,
  monitorMessageOf,
  monitorRowEntry,
  monitorRowPayload,
} from '../utils/monitor-text';
import { persistItemAndEmit } from '../utils/persist-item';
import { AgentEventBus } from './agent-events.bus';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { MonitorRegistry } from './monitor.registry';

/** Where a monitor's rows are filed — `nodeId` null only for a row read back without one. */
export interface MonitorRowOwner {
  runId: MonitorOwner['runId'];
  memberId: string | null;
  callId: MonitorOwner['callId'];
  conversationId: MonitorOwner['conversationId'];
}

/**
 * The transcript's own record of each monitor that no delivery writes: its
 * start, and an end nobody is woken for (the agent's own `stop_monitor`, the
 * thread's Stop, archive). The start row is also what the next boot's sweep
 * finds a monitor by — one with no end row was cut off by the restart.
 *
 * A row the agent IS woken with is written by its delivery instead, as the
 * opening row of the turn it starts — the row and the turn are one event. A
 * delivery that drops such a message writes its end here ({@link writeEnds}),
 * so no monitor is left with a start and no end for a later boot to misread.
 */
@Injectable()
export class MonitorRowWriter implements OnModuleInit {
  private readonly logger = new Logger(MonitorRowWriter.name);

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
    private readonly monitors: MonitorRegistry,
  ) {}

  onModuleInit(): void {
    this.monitors.subscribe((event) => {
      const entry = rowEntryOf(event);
      const { owner } = event.monitor;
      return entry === null
        ? undefined
        : // A chat's own rows carry no member.
          this.write(
            {
              ...owner,
              memberId: owner.target === 'chat' ? null : owner.memberId,
            },
            entry,
          );
    });
  }

  /** Write the end rows of messages a delivery is dropping — those that carry one. */
  async writeEnds(
    owner: MonitorRowOwner,
    messages: Iterable<MonitorMessage>,
  ): Promise<void> {
    for (const message of messages) {
      if (message.end !== undefined) {
        await this.write(owner, monitorRowEntry(message, 'end'));
      }
    }
  }

  /** Write one monitor row under its conversation. Never throws. */
  async write(owner: MonitorRowOwner, entry: MonitorRowPayload): Promise<void> {
    try {
      const em = this.em.fork();
      // A deleted run has no transcript left to write into.
      if ((await this.runDao.getById(owner.runId, em)) === null) {
        return;
      }
      await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId: owner.runId,
          memberId: owner.memberId,
          seq: await this.seqs.reserve(owner.runId),
          kind: 'system',
          role: null,
          payload: monitorRowPayload(
            [entry],
            owner.callId,
            false,
            owner.conversationId,
          ),
        },
      );
    } catch (err) {
      this.logger.error(
        `run ${owner.runId} monitor ${entry.id} ${entry.event} row failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** The row this writer owes an event, or null when a delivery writes it. */
function rowEntryOf(event: MonitorEvent): MonitorRowPayload | null {
  if (event.type === 'start') {
    return monitorRowEntry(
      {
        id: event.monitor.id,
        description: event.monitor.description,
        batch: { lines: [], omitted: 0 },
      },
      'start',
    );
  }
  return event.type === 'end' && !event.wake
    ? monitorRowEntry(monitorMessageOf(event), 'end')
    : null;
}
