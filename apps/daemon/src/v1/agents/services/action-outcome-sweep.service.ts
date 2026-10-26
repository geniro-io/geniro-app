import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { Item } from '../../runs/entity/item.entity';
import {
  type ActionOutcomePayload,
  ActionOutcomePayloadSchema,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { parseJsonColumn } from '../utils/json-util';
import { ChatActionsService } from './chat-actions.service';

/**
 * Ends the command actions a previous daemon left `running`. Their finish row
 * is written by the press that started them, in-process, so a daemon that
 * died meanwhile left the button pending for good; its child is gone too —
 * the stranded-child reaper, first at boot, ended it. Run once at boot, before
 * any press can start a command of this launch.
 */
@Injectable()
export class ActionOutcomeSweep {
  private readonly logger = new Logger(ActionOutcomeSweep.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly actions: ChatActionsService,
  ) {}

  async sweep(): Promise<void> {
    try {
      const byRun = new Map<
        string,
        Pick<Item, 'runId' | 'kind' | 'seq' | 'payload'>[]
      >();
      for (const row of await this.itemDao.allActionRows(this.em.fork())) {
        const rows = byRun.get(row.runId);
        if (rows) {
          rows.push(row);
        } else {
          byRun.set(row.runId, [row]);
        }
      }
      let interrupted = 0;
      for (const [runId, rows] of byRun) {
        // Every publish whose newest outcome is `running` — a live one, or one
        // the agent removed or replaced while it ran (its finish row is
        // written all the same).
        const newest = new Map<number, ActionOutcomePayload>();
        for (const row of rows) {
          if (row.kind !== 'action_outcome') {
            continue;
          }
          const parsed = ActionOutcomePayloadSchema.safeParse(
            parseJsonColumn(row.payload),
          );
          // A removal says nothing about the run under way: the press's
          // finish row would have followed it.
          if (parsed.success && parsed.data.state !== 'removed') {
            newest.set(parsed.data.actionSeq, parsed.data);
          }
        }
        for (const outcome of newest.values()) {
          if (outcome.state !== 'running') {
            continue;
          }
          await this.actions.appendOutcome(runId, null, {
            actionSeq: outcome.actionSeq,
            actionId: outcome.actionId,
            nodeId: outcome.nodeId,
            conversationId: outcome.conversationId,
            state: 'interrupted',
            error: 'the app stopped while it ran',
          });
          interrupted += 1;
        }
      }
      if (interrupted > 0) {
        this.logger.warn(
          `marked ${interrupted} command action(s) a previous launch left running as interrupted`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `could not sweep the command actions left running: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
