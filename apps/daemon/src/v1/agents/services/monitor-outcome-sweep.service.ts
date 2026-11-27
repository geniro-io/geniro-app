import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import {
  continuesUnattended,
  type InterruptCause,
  resumesUnattended,
} from '../../../utils/stop-cause';
import { redactSecrets } from '../../diagnostics/utils/redact';
import type { Item } from '../../runs/entity/item.entity';
import {
  MONITOR_TIMEOUT_DEFAULT_MS,
  type MonitorEnd,
  type MonitorRowPayload,
  type RestartContinuationMonitor,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  asNumber,
  asRecord,
  asString,
  parseJsonColumn,
} from '../utils/json-util';
import { bareToolName } from '../utils/mcp-tool-name';
import {
  type MonitorFacts,
  type MonitorMessage,
  monitorRowEntry,
  monitorRowOf,
  type StoppedMonitor,
  stoppedMonitorLine,
} from '../utils/monitor-text';
import {
  mergeRestartContinuations,
  readRestartContinuation,
  restartContinuationColumn,
} from '../utils/run-restart-continuation';
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
  memberId: string | null;
  callId: string | null;
  conversationId: string | null;
  /** The seq and time of its start row. */
  startSeq: number;
  startedAt: number;
  /** What its start row says of it; none on a row written before rows carried it. */
  facts: MonitorFacts;
}

/**
 * Ends the monitors a previous daemon left running. Their end row is written
 * in-process, so a monitor whose newest row is not an end was cut off by the
 * restart; its command is gone too — the stranded-child reaper, first at
 * boot, ended its group. A monitor is never started again.
 *
 * Its owner is told the monitor's id, description, command and about how long
 * it had left. After an update or a deliberate restart the monitor goes into
 * the run's continuation record (`Run.restartContinuation`), and the drain
 * after listen wakes its owner once with it — the record is created for a run
 * the boot reconcile left none, a team whose lead ended its turn with only a
 * monitor running. A chat without a record is woken through
 * `MonitorChatDelivery`, which waits until the daemon listens and for any card
 * the user still has to answer, unless the daemon crashed (or nobody knows why
 * it stopped), so an unattended restart cannot start turns nobody asked for;
 * such a chat's next turn is owed a note instead, as is the owning
 * conversation of a team after a quit. An archived or cancelled run gets
 * neither.
 *
 * Every id the rows of a run it reads hold is handed to the registry, whose
 * counter is per launch, so a new monitor never reuses one; `MonitorBroker`
 * reads the ids of any other run before its first monitor of the launch.
 */
function factsOfEntry(entry: MonitorRowPayload): MonitorFacts {
  return {
    ...(typeof entry.command === 'string' ? { command: entry.command } : {}),
    ...(typeof entry.startedAt === 'string'
      ? { startedAt: entry.startedAt }
      : {}),
    ...(typeof entry.timeoutMs === 'number'
      ? { timeoutMs: entry.timeoutMs }
      : {}),
  };
}

/** A monitor's command as its agent is shown it again: registered secrets masked. */
function commandOf(value: unknown): string | null {
  const command = asString(value);
  return command === null ? null : redactSecrets(command);
}

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

  /**
   * `cause` is the stop note the boot already read — it is gone from disk.
   * Answers the runs of `runIds` left with a monitor not durably ended: every
   * one on a failure, else each chat whose end waits on a delivery after listen.
   */
  async sweep(
    cause: InterruptCause,
    runIds: readonly string[],
  ): Promise<string[]> {
    try {
      let interrupted = 0;
      const unsettled: string[] = [];
      for (const [runId, cutOff] of await this.cutOffByRun(runIds)) {
        interrupted += cutOff.length;
        if (await this.close(runId, cutOff, cause)) {
          unsettled.push(runId);
        }
      }
      if (interrupted > 0) {
        this.logger.warn(
          `marked ${interrupted} monitor(s) a previous launch left running as interrupted`,
        );
      }
      return unsettled;
    } catch (err: unknown) {
      this.logger.error(
        `could not sweep the monitors left running: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [...runIds];
    }
  }

  /** These runs' monitors whose newest row is not an end. */
  private async cutOffByRun(
    runIds: readonly string[],
  ): Promise<Map<string, CutOff[]>> {
    const newest = new Map<
      string,
      Map<string, { entry: MonitorRowPayload; cutOff: CutOff }>
    >();
    for (const row of await this.itemDao.monitorRowsOfRuns(
      runIds,
      this.em.fork(),
    )) {
      const payload = monitorRowOf(row.payload);
      if (payload === null) {
        continue;
      }
      const byId =
        newest.get(row.runId) ??
        new Map<string, { entry: MonitorRowPayload; cutOff: CutOff }>();
      for (const entry of payload.monitors) {
        // Its owner is read off its first row (its start, which the writer
        // stamps whole); a delivered message's row names no conversation.
        const first = byId.get(entry.id)?.cutOff;
        byId.set(entry.id, {
          entry,
          cutOff: first ?? {
            id: entry.id,
            description: String(entry.description ?? entry.id),
            memberId: row.memberId,
            callId: payload.callId,
            conversationId: payload.conversationId,
            startSeq: row.seq,
            startedAt: row.createdAt.getTime(),
            facts: factsOfEntry(entry),
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
    if (isChat || monitor.memberId === null) {
      return runId;
    }
    return monitor.conversationId === null
      ? nodeSessionKey(runId, monitor.memberId)
      : callSessionKey(runId, monitor.conversationId);
  }

  /** Whether an end of the run is not on disk yet: held for a delivery after listen, or its write failed. */
  private async close(
    runId: string,
    cutOff: CutOff[],
    cause: InterruptCause,
  ): Promise<boolean> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      return false;
    }
    const isChat = run.teamId === null || run.teamId === undefined;
    const stopped = await this.stoppedOf(runId, cutOff);
    const message = (monitor: CutOff): MonitorMessage => {
      const named = stopped.get(monitor.id);
      const command = monitor.facts.command ?? named?.command ?? null;
      return {
        id: monitor.id,
        description: monitor.description,
        ...monitor.facts,
        ...(command === null ? {} : { command }),
        startedAt:
          monitor.facts.startedAt ?? new Date(monitor.startedAt).toISOString(),
        batch: { lines: [], omitted: 0 },
        end: INTERRUPTED,
        stopped: named,
      };
    };
    const live = run.archivedAt === null && run.status !== 'cancelled';
    const owed = readRestartContinuation(run.restartContinuation ?? null);
    const continued = isChat
      ? live && continuesUnattended(cause) && owed !== null
      : live;
    if (continued) {
      const monitors: RestartContinuationMonitor[] = cutOff.map((monitor) => ({
        memberId: isChat ? null : monitor.memberId,
        conversationId: monitor.conversationId,
        ...stopped.get(monitor.id)!,
      }));
      await this.runDao.setRestartContinuation(
        runId,
        restartContinuationColumn(
          mergeRestartContinuations(owed, {
            cause,
            held: !resumesUnattended(cause),
            turns: [],
            calls: [],
            failedCalls: [],
            monitors,
          }),
        ),
        em,
      );
      return this.writeEnds(runId, cutOff, message, true);
    }
    if (isChat && live && !UNCHOSEN_STOPS.includes(cause)) {
      const [first] = cutOff;
      this.chats.holdInterrupted(
        {
          runId,
          memberId: first?.memberId ?? null,
          callId: null,
          conversationId: null,
        },
        cutOff.map(message),
      );
      return true;
    }
    const unwritten = await this.writeEnds(runId, cutOff, message, false);
    if (!live) {
      return unwritten;
    }
    for (const monitor of cutOff) {
      const note = `[geniro] geniro restarted, which stopped your monitor ${stoppedMonitorLine(stopped.get(monitor.id)!)}. It was not started again — start one with monitor if you still need it.`;
      this.sessions.oweKeyNote(
        this.conversationKey(runId, isChat, monitor),
        note,
      );
    }
    return unwritten;
  }

  /** Each monitor's end row; answers whether any could not be written. */
  private async writeEnds(
    runId: string,
    cutOff: readonly CutOff[],
    message: (monitor: CutOff) => MonitorMessage,
    woke: boolean,
  ): Promise<boolean> {
    let unwritten = false;
    for (const monitor of cutOff) {
      const written = await this.rows.write(
        {
          runId,
          memberId: monitor.memberId,
          callId: monitor.callId,
          conversationId: monitor.conversationId,
        },
        monitorRowEntry(message(monitor), 'end'),
        woke,
      );
      unwritten ||= !written;
    }
    return unwritten;
  }

  /**
   * What each cut-off monitor's agent is told about it. Its own rows hold no
   * command, so it is read off the `monitor` tool call that started it: the
   * newest one of the same member before its start row naming its
   * description. The time left counts from that start row.
   */
  private async stoppedOf(
    runId: string,
    cutOff: readonly CutOff[],
  ): Promise<Map<string, StoppedMonitor>> {
    let calls: Pick<Item, 'memberId' | 'seq' | 'payload'>[] = [];
    try {
      calls = await this.itemDao.monitorToolCallsOfRun(runId, this.em.fork());
    } catch (err: unknown) {
      this.logger.warn(
        `run ${runId}: could not read the commands of its interrupted monitors: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const inputs = calls.flatMap((call) => {
      const payload = asRecord(parseJsonColumn(call.payload));
      const name = asString(payload?.name);
      const input = asRecord(payload?.input);
      return name !== null && bareToolName(name) === 'monitor' && input !== null
        ? [{ memberId: call.memberId, seq: call.seq, input }]
        : [];
    });
    const now = Date.now();
    return new Map(
      cutOff.map((monitor) => {
        const started = inputs.findLast(
          (call) =>
            call.seq < monitor.startSeq &&
            call.memberId === monitor.memberId &&
            asString(call.input.description) === monitor.description,
        );
        const timeoutMs =
          started === undefined
            ? null
            : (asNumber(started.input.timeout_ms) ??
              MONITOR_TIMEOUT_DEFAULT_MS);
        return [
          monitor.id,
          {
            id: monitor.id,
            description: monitor.description,
            command: commandOf(started?.input.command),
            remainingMs:
              timeoutMs === null
                ? null
                : Math.max(0, timeoutMs - (now - monitor.startedAt)),
          },
        ];
      }),
    );
  }
}
