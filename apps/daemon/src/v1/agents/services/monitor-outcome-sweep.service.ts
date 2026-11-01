import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import type { InterruptCause } from '../../../utils/stop-cause';
import type { MonitorEnd, MonitorRowPayload } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { parseJsonColumn } from '../utils/json-util';
import { type MonitorMessage, monitorRowEntry } from '../utils/monitor-text';
import { callSessionKey, nodeSessionKey } from '../utils/session-keys';
import { AgentSessionRegistry } from './agent-session.registry';
import { MonitorRegistry } from './monitor.registry';
import { MonitorChatDelivery } from './monitor-chat-delivery.service';
import { MonitorRowWriter } from './monitor-row.writer';

/** A stop after which nobody is woken: the user did not choose it. */
const UNCHOSEN_STOPS: readonly InterruptCause[] = ['crash', 'unknown'];

const INTERRUPTED: MonitorEnd = { kind: 'interrupted' };

interface CutOff {
  id: string;
  description: string;
  nodeId: string | null;
  callId: string | null;
  conversationId: string | null;
}

/**
 * Ends the monitors a previous daemon left running. Their end row is written
 * in-process, so a monitor whose newest row is not an end was cut off by the
 * restart; its command is gone too — the stranded-child reaper, first at
 * boot, ended its group. A monitor is never started again.
 *
 * A chat is woken to be told — through `MonitorChatDelivery`, which waits
 * until the daemon listens and for any card the user still has to answer —
 * unless the daemon crashed (or nobody knows why it stopped), so an
 * unattended restart cannot start turns nobody asked for; such a chat's next
 * turn is owed a note instead. A team's turn state did not survive, so the
 * owning conversation's next turn is owed one. An archived run gets neither.
 *
 * Every id a run's rows hold is handed to the registry, whose counter is per
 * launch, so a new monitor never reuses one.
 */
@Injectable()
export class MonitorOutcomeSweep {
  private readonly logger = new Logger(MonitorOutcomeSweep.name);

  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly runDao: RunDao,
    private readonly rows: MonitorRowWriter,
    private readonly chats: MonitorChatDelivery,
    private readonly sessions: AgentSessionRegistry,
    private readonly monitors: MonitorRegistry,
  ) {}

  /** `cause` is the stop note the boot already read — it is gone from disk. */
  async sweep(cause: InterruptCause): Promise<void> {
    try {
      let interrupted = 0;
      for (const [runId, cutOff] of await this.cutOffByRun()) {
        interrupted += cutOff.length;
        await this.close(runId, cutOff, cause);
      }
      if (interrupted > 0) {
        this.logger.warn(
          `marked ${interrupted} monitor(s) a previous launch left running as interrupted`,
        );
      }
    } catch (err: unknown) {
      this.logger.error(
        `could not sweep the monitors left running: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Every run's monitors whose newest row is not an end. */
  private async cutOffByRun(): Promise<Map<string, CutOff[]>> {
    const newest = new Map<
      string,
      Map<string, { entry: MonitorRowPayload; cutOff: CutOff }>
    >();
    for (const row of await this.itemDao.allMonitorRows(this.em.fork())) {
      const payload = parseJsonColumn(row.payload) as {
        monitors?: unknown;
        callId?: unknown;
        conversationId?: unknown;
      } | null;
      if (payload === null || !Array.isArray(payload.monitors)) {
        continue;
      }
      const byId =
        newest.get(row.runId) ??
        new Map<string, { entry: MonitorRowPayload; cutOff: CutOff }>();
      for (const entry of payload.monitors as MonitorRowPayload[]) {
        if (typeof entry?.id !== 'string' || typeof entry.event !== 'string') {
          continue;
        }
        // Its owner is read off its first row (its start, which the writer
        // stamps whole); a delivered message's row names no conversation.
        const first = byId.get(entry.id)?.cutOff;
        byId.set(entry.id, {
          entry,
          cutOff: first ?? {
            id: entry.id,
            description: String(entry.description ?? entry.id),
            nodeId: row.nodeId,
            callId: typeof payload.callId === 'string' ? payload.callId : null,
            conversationId:
              typeof payload.conversationId === 'string'
                ? payload.conversationId
                : null,
          },
        });
      }
      newest.set(row.runId, byId);
    }
    const byRun = new Map<string, CutOff[]>();
    for (const [runId, byId] of newest) {
      this.monitors.noteUsedIds(runId, byId.keys());
      const cutOff = [...byId.values()]
        .filter(({ entry }) => entry.event !== 'end')
        .map(({ cutOff }) => cutOff);
      if (cutOff.length > 0) {
        byRun.set(runId, cutOff);
      }
    }
    return byRun;
  }

  /** The session key of the conversation a monitor belonged to. */
  private conversationKey(
    runId: string,
    isChat: boolean,
    monitor: CutOff,
  ): string {
    if (isChat || monitor.nodeId === null) {
      return runId;
    }
    return monitor.conversationId === null
      ? nodeSessionKey(runId, monitor.nodeId)
      : callSessionKey(runId, monitor.conversationId);
  }

  private async close(
    runId: string,
    cutOff: CutOff[],
    cause: InterruptCause,
  ): Promise<void> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null) {
      return;
    }
    const isChat = run.teamId === null || run.teamId === undefined;
    const message = (monitor: CutOff): MonitorMessage => ({
      id: monitor.id,
      description: monitor.description,
      batch: { lines: [], omitted: 0 },
      end: INTERRUPTED,
    });
    if (isChat && run.archivedAt === null && !UNCHOSEN_STOPS.includes(cause)) {
      const [first] = cutOff;
      this.chats.holdInterrupted(
        {
          runId,
          nodeId: first?.nodeId ?? null,
          callId: null,
          conversationId: null,
        },
        cutOff.map(message),
      );
      return;
    }
    for (const monitor of cutOff) {
      await this.rows.write(
        {
          runId,
          nodeId: monitor.nodeId,
          callId: monitor.callId,
          conversationId: monitor.conversationId,
        },
        monitorRowEntry(message(monitor), 'end'),
      );
    }
    if (run.archivedAt !== null) {
      return;
    }
    for (const monitor of cutOff) {
      const note = `[geniro] geniro restarted, which stopped your monitor ${monitor.id} (${monitor.description}). It was not started again — start one with monitor if you still need it.`;
      this.sessions.oweKeyNote(
        this.conversationKey(runId, isChat, monitor),
        note,
      );
    }
  }
}
