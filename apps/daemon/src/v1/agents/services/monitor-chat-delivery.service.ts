import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import type { MonitorEvent } from '../chat.types';
import {
  holdMonitorMessage,
  type MonitorMessage,
  monitorMessageOf,
  monitorWake,
} from '../utils/monitor-text';
import { AgentSessionRegistry } from './agent-session.registry';
import { ChatService } from './chat.service';
import { MonitorRegistry } from './monitor.registry';
import { type MonitorRowOwner, MonitorRowWriter } from './monitor-row.writer';

interface HeldOutput {
  owner: MonitorRowOwner;
  messages: Map<string, MonitorMessage>;
}

/** Sends in a row that may fail to start a turn before the run's monitors are stopped. */
export const MONITOR_SEND_ATTEMPTS = 3;

/** How long a failed send waits before it is tried again, unless a turn settles first. */
export const MONITOR_SEND_RETRY_MS = 30_000;

interface SendFailures {
  count: number;
  retry: NodeJS.Timeout;
}

/**
 * Wakes a chat's agent with its monitors' output.
 *
 * Never into a running turn, on any CLI: output that arrives while the agent
 * works is held — one message per monitor, later batches merged into it — and
 * goes out when the turn ends, as a turn of its own whose opening row is the
 * monitor row rather than a user message. A question, plan or patch card left
 * for the user holds it too: the user's answer starts the next turn, and this
 * waits for that turn's end. The thread's Stop drops what is held.
 *
 * A send that cannot start a turn before its opening row is written (a folder
 * gone, a failed write) is tried again — at the chat's next settled turn, or
 * after {@link MONITOR_SEND_RETRY_MS} — and only the
 * {@link MONITOR_SEND_ATTEMPTS}th failure in a row stops the run's monitors, so
 * a fault that clears on its own costs nothing and one that does not cannot
 * retry on every batch. A failure after the row was written (a model refused)
 * is not retried: the transcript already shows the output, and a retry would
 * show it twice.
 */
@Injectable()
export class MonitorChatDelivery implements OnModuleInit {
  private readonly logger = new Logger(MonitorChatDelivery.name);
  /** Output waiting for its chat to be free, by run. */
  private readonly held = new Map<string, HeldOutput>();
  /** Until the daemon serves its endpoint a woken turn would have no tools. */
  private listening = false;
  /** Runs whose last sends failed, waiting out the retry. */
  private readonly failures = new Map<string, SendFailures>();
  /** Runs this service is sending to: the settle a failed send announces is its own. */
  private readonly sending = new Set<string>();
  /** Bumped by the thread's Stop, so a send in flight across it is not retried. */
  private readonly stops = new Map<string, number>();

  constructor(
    private readonly monitors: MonitorRegistry,
    private readonly chats: ChatService,
    private readonly rows: MonitorRowWriter,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.monitors.subscribe((event) => this.receive(event));
    // A settled turn is a chat that can start turns again: a send waiting out
    // its retry goes now.
    this.chats.onTurnSettled((runId) => {
      if (!this.sending.has(runId)) {
        void this.release(runId, true);
      }
    });
    this.chats.onStopped((runId) => this.drop(runId));
  }

  /**
   * Hold a chat's wake for monitors a previous daemon left running — the boot
   * sweep's, sent once the daemon listens ({@link startDelivering}).
   */
  holdInterrupted(owner: MonitorRowOwner, messages: MonitorMessage[]): void {
    const held = this.heldFor(owner);
    for (const message of messages) {
      holdMonitorMessage(held.messages, message);
    }
  }

  /**
   * The daemon serves its MCP endpoint now: a woken turn gets its tools, and
   * every boot reconcile (the deferred cards a wake would otherwise retire,
   * the adapters' stale-state sweep) has run.
   */
  startDelivering(): void {
    this.listening = true;
    for (const runId of [...this.held.keys()]) {
      void this.release(runId);
    }
  }

  private receive(event: MonitorEvent): void {
    const { monitor } = event;
    if (monitor.owner.target !== 'chat' || event.type === 'start') {
      return;
    }
    const runId = monitor.owner.runId;
    if (event.type === 'end' && !event.wake) {
      // Stopped by the agent itself or with the thread: nothing more is sent,
      // including output held from before the stop.
      this.held.get(runId)?.messages.delete(monitor.id);
      return;
    }
    holdMonitorMessage(
      this.heldFor(monitor.owner).messages,
      monitorMessageOf(event),
    );
    void this.release(runId);
  }

  private heldFor(owner: MonitorRowOwner): HeldOutput {
    const existing = this.held.get(owner.runId);
    if (existing !== undefined) {
      return existing;
    }
    const held: HeldOutput = {
      owner: {
        runId: owner.runId,
        // A chat's own rows carry no member.
        memberId: null,
        callId: owner.callId,
        conversationId: owner.conversationId,
      },
      messages: new Map(),
    };
    this.held.set(owner.runId, held);
    return held;
  }

  /** The thread's Stop: what is held goes nowhere, and its ends are recorded. */
  private drop(runId: string): void {
    const held = this.held.get(runId);
    this.held.delete(runId);
    this.forgetFailures(runId);
    this.stops.set(runId, (this.stops.get(runId) ?? 0) + 1);
    if (held !== undefined) {
      void this.rows.writeEnds(held.owner, held.messages.values());
    }
  }

  /**
   * Send what the run's monitors hold, if the chat can take a turn now. New
   * output does not retry a failed send early (`retryNow` is a settled turn
   * or the retry's own timer).
   */
  private async release(runId: string, retryNow = false): Promise<void> {
    const held = this.held.get(runId);
    if (!this.listening) {
      return;
    }
    if (held === undefined || held.messages.size === 0) {
      // Nothing left to retry (its monitor was stopped meanwhile).
      this.forgetFailures(runId);
      return;
    }
    if (!retryNow && this.failures.has(runId)) {
      return;
    }
    const hold = this.chats.hostTurnHold(runId);
    if (hold === 'wait') {
      return;
    }
    // Taken before the first await, so a second release cannot send them too.
    this.held.delete(runId);
    const sent = [...held.messages.values()];
    if (hold === 'closing') {
      this.forgetFailures(runId);
      await this.rows.writeEnds(held.owner, sent);
      return;
    }
    const { prompt, row } = monitorWake(sent);
    // The opening row carries the messages' ends: once written, a failure
    // after it must not record them a second time.
    let opened = false;
    const stopsBefore = this.stops.get(runId) ?? 0;
    this.sending.add(runId);
    try {
      await this.chats.sendMessage(runId, prompt, [], {
        ownTurn: true,
        hostRow: row,
        onHostRowWritten: () => {
          opened = true;
        },
      });
      this.forgetFailures(runId);
    } catch (err) {
      if ((this.stops.get(runId) ?? 0) !== stopsBefore) {
        // The thread's Stop came while it was sent: nothing more goes out.
        if (!opened) {
          await this.rows.writeEnds(held.owner, sent);
        }
        return;
      }
      if (err instanceof ConflictException && err.errorCode === 'RUN_BUSY') {
        // A turn claimed the chat in between (a queued message, a compaction):
        // held again for that turn's end, merged with whatever came meanwhile.
        this.putBack(held.owner, sent);
        return;
      }
      // Archived, or a turn that cannot start (its folder gone, its model
      // refused): tried again a few times, then its monitors stop.
      const archived =
        err instanceof ConflictException && err.errorCode === 'RUN_ARCHIVED';
      const failures = (this.failures.get(runId)?.count ?? 0) + 1;
      this.forgetFailures(runId);
      if (!archived && !opened && failures < MONITOR_SEND_ATTEMPTS) {
        this.logger.warn(
          `run ${runId} could not deliver monitor output (attempt ${failures} of ${MONITOR_SEND_ATTEMPTS}), trying again: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.putBack(held.owner, sent);
        const retry = setTimeout(
          () => void this.release(runId, true),
          MONITOR_SEND_RETRY_MS,
        );
        retry.unref();
        this.failures.set(runId, { count: failures, retry });
        return;
      }
      const stopped = this.monitors.list(runId);
      this.monitors.stopRun(runId, 'teardown');
      if (!archived) {
        this.logger.error(
          `run ${runId} could not deliver monitor output, stopping its monitors: ${err instanceof Error ? err.message : String(err)}`,
        );
        // The chat lives on: its next turn hears what became of them.
        const named = [
          ...new Map(
            [...sent, ...stopped].map((m) => [
              m.id,
              `${m.id} (${m.description})`,
            ]),
          ).values(),
        ];
        this.sessions.oweKeyNote(
          runId,
          `[geniro] A turn could not be started to deliver the output of your monitor${named.length === 1 ? '' : 's'} ${named.join(', ')}, so ${named.length === 1 ? 'it was' : 'they were'} stopped. Start one again with monitor if you still need it.`,
        );
      }
      if (!opened) {
        await this.rows.writeEnds(held.owner, sent);
      }
    } finally {
      this.sending.delete(runId);
    }
  }

  private forgetFailures(runId: string): void {
    clearTimeout(this.failures.get(runId)?.retry);
    this.failures.delete(runId);
  }

  private putBack(
    owner: MonitorRowOwner,
    sent: readonly MonitorMessage[],
  ): void {
    const later = this.held.get(owner.runId);
    const merged = new Map<string, MonitorMessage>();
    for (const message of [...sent, ...(later?.messages.values() ?? [])]) {
      holdMonitorMessage(merged, message);
    }
    this.held.set(owner.runId, { owner, messages: merged });
  }
}
