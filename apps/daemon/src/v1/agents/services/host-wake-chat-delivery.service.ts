import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConflictException } from '@packages/common';

import type { HostWake } from '../chat.types';
import { AgentSessionRegistry } from './agent-session.registry';
import { ChatService } from './chat.service';
import {
  HostWakeBus,
  hostWakeSessionKey,
  joinHostWakes,
  unwithdrawn,
} from './host-wake.bus';

/** Sends in a row that may fail before the wakes become notes for the next turn. */
export const HOST_WAKE_SEND_ATTEMPTS = 3;

/** How long a failed send waits before it is tried again, unless a turn settles first. */
export const HOST_WAKE_SEND_RETRY_MS = 30_000;

/**
 * Wakes a chat's agent with what geniro did for it outside its turn — on
 * `MonitorChatDelivery`'s terms but on its own hold: never into a running
 * turn or past a card waiting for the user, sent once the daemon listens, as
 * a turn of its own whose opening row is the wake's host row.
 *
 * A turn claiming the chat first (`RUN_BUSY`) holds the wakes again for its
 * end. Any other failure to start the turn is tried again a few times; past
 * that, and for a chat being archived or deleted, or stopped by the user,
 * the wakes become a note owed to its next turn. A turn that opened, or the
 * note owed in its place, settles the wake.
 */
@Injectable()
export class HostWakeChatDelivery implements OnModuleInit {
  private readonly logger = new Logger(HostWakeChatDelivery.name);
  /** Wakes waiting for their chat, by run, then by wake key. */
  private readonly held = new Map<string, Map<string, HostWake>>();
  private listening = false;
  private readonly failures = new Map<
    string,
    { count: number; retry: NodeJS.Timeout }
  >();
  /** Sends in flight, by run: the settle a failed send announces is its own. */
  private readonly sending = new Map<string, number>();
  /** Bumped by the thread's Stop, so a send in flight across it is not retried. */
  private readonly stops = new Map<string, number>();

  constructor(
    private readonly bus: HostWakeBus,
    private readonly chats: ChatService,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe((wake) => {
      if (wake.owner.target !== 'chat') {
        return;
      }
      const held = this.held.get(wake.owner.runId) ?? new Map();
      held.set(wake.key, wake);
      this.held.set(wake.owner.runId, held);
      void this.release(wake.owner.runId);
    });
    this.chats.onTurnSettled((runId) => {
      if (!this.sending.has(runId)) {
        void this.release(runId, true);
      }
    });
    // The user stopped the agent: nothing starts it again on its own.
    this.chats.onStopped((runId) => {
      if (this.sending.has(runId)) {
        this.stops.set(runId, (this.stops.get(runId) ?? 0) + 1);
      }
      this.owe(runId);
    });
  }

  /** The daemon serves its MCP endpoint now: a woken turn gets its tools. */
  startDelivering(): void {
    this.listening = true;
    for (const runId of [...this.held.keys()]) {
      void this.release(runId);
    }
  }

  private async release(runId: string, retryNow = false): Promise<void> {
    const held = this.held.get(runId);
    if (!this.listening || held === undefined || held.size === 0) {
      return;
    }
    if (!retryNow && this.failures.has(runId)) {
      return;
    }
    const hold = this.chats.hostTurnHold(runId);
    if (hold === 'wait') {
      return;
    }
    if (hold === 'closing') {
      this.owe(runId);
      return;
    }
    this.held.delete(runId);
    const wakes = unwithdrawn(held.values());
    if (wakes.length === 0) {
      return;
    }
    const { prompt, row } = joinHostWakes(wakes);
    let opened = false;
    const stopsBefore = this.stops.get(runId) ?? 0;
    this.sending.set(runId, (this.sending.get(runId) ?? 0) + 1);
    try {
      await this.chats.sendMessage(runId, prompt, [], {
        ownTurn: true,
        hostRow: row,
        onHostRowWritten: () => {
          opened = true;
        },
      });
      this.forgetFailures(runId);
      for (const wake of wakes) {
        wake.onDelivered();
      }
    } catch (err) {
      if ((this.stops.get(runId) ?? 0) !== stopsBefore) {
        // The thread's Stop came while it was sent: nothing starts it again.
        this.putBack(runId, wakes);
        this.owe(runId);
        return;
      }
      if (err instanceof ConflictException && err.errorCode === 'RUN_BUSY') {
        this.putBack(runId, wakes);
        return;
      }
      const archived =
        err instanceof ConflictException && err.errorCode === 'RUN_ARCHIVED';
      const failures = (this.failures.get(runId)?.count ?? 0) + 1;
      this.forgetFailures(runId);
      if (!archived && !opened && failures < HOST_WAKE_SEND_ATTEMPTS) {
        this.logger.warn(
          `run ${runId} could not start a turn for ${wakes.length} host wake(s) (attempt ${failures} of ${HOST_WAKE_SEND_ATTEMPTS}), trying again: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.putBack(runId, wakes);
        const retry = setTimeout(
          () => void this.release(runId, true),
          HOST_WAKE_SEND_RETRY_MS,
        );
        retry.unref();
        this.failures.set(runId, { count: failures, retry });
        return;
      }
      this.putBack(runId, wakes);
      this.owe(runId);
    } finally {
      // Cleared only with the run's last send, so an overlapping one keeps
      // the Stop count it still compares against.
      const left = (this.sending.get(runId) ?? 1) - 1;
      if (left > 0) {
        this.sending.set(runId, left);
      } else {
        this.sending.delete(runId);
        this.stops.delete(runId);
      }
    }
  }

  /**
   * What the run holds becomes notes for its next turn — the wake's last
   * attempt, so it settles the wake: a boot never sends it again.
   */
  private owe(runId: string): void {
    const held = this.held.get(runId);
    this.held.delete(runId);
    this.forgetFailures(runId);
    for (const wake of unwithdrawn(held?.values() ?? [])) {
      // Settled only when the note was kept: one dropped at shutdown leaves
      // the share owed, for the next boot to send.
      if (this.sessions.oweKeyNote(hostWakeSessionKey(wake.owner), wake.note)) {
        wake.onDelivered();
      }
    }
  }

  private putBack(runId: string, wakes: readonly HostWake[]): void {
    const merged = new Map(wakes.map((wake) => [wake.key, wake]));
    for (const [key, later] of this.held.get(runId) ?? []) {
      merged.set(key, later);
    }
    this.held.set(runId, merged);
  }

  private forgetFailures(runId: string): void {
    clearTimeout(this.failures.get(runId)?.retry);
    this.failures.delete(runId);
  }
}
