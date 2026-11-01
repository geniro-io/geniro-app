import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { MonitorEvent } from '../../agents/chat.types';
import { MonitorRegistry } from '../../agents/services/monitor.registry';
import {
  type MonitorRowOwner,
  MonitorRowWriter,
} from '../../agents/services/monitor-row.writer';
import {
  holdMonitorMessage,
  type MonitorMessage,
  monitorMessageOf,
  monitorWake,
} from '../../agents/utils/monitor-text';
import { TeamExecutorService } from './team-executor.service';

interface HeldOutput {
  owner: MonitorRowOwner;
  messages: Map<string, MonitorMessage>;
}

/**
 * Wakes a team conversation with its monitors' output — the team twin
 * of `MonitorChatDelivery`, on the same rule: never into a running turn.
 * Output that arrives while the conversation works is held, one message per
 * monitor, and goes out when its turn ends (`onConversationTurnEnded`) — for a
 * member's own conversation as a turn of its own, for a callee as a wake inside
 * the call its monitors hold open.
 */
@Injectable()
export class MonitorGraphDelivery implements OnModuleInit {
  private readonly logger = new Logger(MonitorGraphDelivery.name);
  /** Output waiting for its conversation, by run and caller key. */
  private readonly held = new Map<string, HeldOutput>();

  constructor(
    private readonly monitors: MonitorRegistry,
    private readonly executor: TeamExecutorService,
    private readonly rows: MonitorRowWriter,
  ) {}

  onModuleInit(): void {
    this.monitors.subscribe((event) => this.receive(event));
    this.executor.onConversationTurnEnded((runId, caller) =>
      this.release(runId, caller),
    );
    this.executor.setMonitorOutputHeld(
      (runId, caller) =>
        (this.held.get(heldKey(runId, caller))?.messages.size ?? 0) > 0,
    );
  }

  /** Whether any conversation of the run has monitor output waiting for it. */
  owesOutput(runId: string): boolean {
    const prefix = heldKey(runId, '');
    return [...this.held].some(
      ([key, held]) => key.startsWith(prefix) && held.messages.size > 0,
    );
  }

  private receive(event: MonitorEvent): void {
    const { monitor } = event;
    const { runId, caller, target } = monitor.owner;
    if (target !== 'team' || event.type === 'start') {
      return;
    }
    const key = heldKey(runId, caller);
    if (event.type === 'end' && !event.wake) {
      this.held.get(key)?.messages.delete(monitor.id);
      // A callee held only for this monitor may settle now.
      this.executor.reviewMonitorHold(runId, caller);
      return;
    }
    const held = this.held.get(key) ?? {
      owner: {
        runId,
        memberId: monitor.owner.memberId,
        callId: monitor.owner.callId,
        conversationId: monitor.owner.conversationId,
      },
      messages: new Map<string, MonitorMessage>(),
    };
    holdMonitorMessage(held.messages, monitorMessageOf(event));
    this.held.set(key, held);
    this.release(runId, caller);
  }

  private release(runId: string, caller: string): void {
    const key = heldKey(runId, caller);
    const held = this.held.get(key);
    if (held === undefined || held.messages.size === 0) {
      return;
    }
    const sent = [...held.messages.values()];
    const { prompt, row } = monitorWake(sent);
    // Stopped, deleted, or a callee whose call has settled: nothing will read
    // it. Its end is still the transcript's to record.
    const dropped = (): void => {
      this.logger.warn(
        `run ${runId} conversation ${caller}: monitor output dropped — no turn can take it`,
      );
      void this.rows.writeEnds(held.owner, sent);
    };
    // A user's message started the run's next pass first: held again, merged
    // with what came meanwhile, for that conversation's next turn end.
    const handedBack = (requeue: boolean): void => {
      if (!requeue) {
        dropped();
        return;
      }
      const later = this.held.get(key);
      const messages = new Map<string, MonitorMessage>();
      for (const message of [...sent, ...(later?.messages.values() ?? [])]) {
        holdMonitorMessage(messages, message);
      }
      this.held.set(key, { owner: held.owner, messages });
    };
    const woke = this.executor.wakeConversation(
      runId,
      caller,
      prompt,
      row,
      handedBack,
    );
    if (woke === 'busy') {
      return;
    }
    this.held.delete(key);
    if (woke === 'refused') {
      dropped();
    }
  }
}

function heldKey(runId: string, caller: string): string {
  return `${runId}\u0000${caller}`;
}
