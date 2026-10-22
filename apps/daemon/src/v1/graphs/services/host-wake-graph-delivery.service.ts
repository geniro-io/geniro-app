import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { HostWake } from '../../agents/chat.types';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import {
  HostWakeBus,
  hostWakeSessionKey,
  joinHostWakes,
  unwithdrawn,
} from '../../agents/services/host-wake.bus';
import { GraphExecutorService } from './graph-executor.service';

/**
 * Wakes a workflow conversation with what geniro did for it outside its turn
 * — the workflow twin of `HostWakeChatDelivery`. Held while the conversation
 * works and sent when its turn ends, through the executor's own-turn path
 * (`wakeConversation`, opener `host`), so it settles as a host turn and is
 * never counted against the monitor wake limit.
 *
 * A wake the executor took is settled when that conversation's turn ends;
 * one it refuses (a stopped run, a callee whose call has settled, a run no
 * pass has driven since the daemon started) or drops before the turn starts
 * becomes a note owed to the conversation's next turn, which settles it too.
 */
@Injectable()
export class HostWakeGraphDelivery implements OnModuleInit {
  /** Wakes waiting for their conversation, by run and caller, then by key. */
  private readonly held = new Map<string, Map<string, HostWake>>();
  /** Wakes a turn was started for, confirmed when that turn ends. */
  private readonly inFlight = new Map<string, HostWake[]>();

  constructor(
    private readonly bus: HostWakeBus,
    private readonly executor: GraphExecutorService,
    private readonly sessions: AgentSessionRegistry,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe((wake) => {
      if (wake.owner.target !== 'workflow') {
        return;
      }
      const key = heldKey(wake.owner.runId, wake.owner.caller);
      const held = this.held.get(key) ?? new Map();
      held.set(wake.key, wake);
      this.held.set(key, held);
      this.release(wake.owner.runId, wake.owner.caller);
    });
    this.executor.onConversationTurnEnded((runId, caller) => {
      const key = heldKey(runId, caller);
      for (const wake of this.inFlight.get(key) ?? []) {
        wake.onDelivered();
      }
      this.inFlight.delete(key);
      this.release(runId, caller);
    });
  }

  private release(runId: string, caller: string): void {
    const key = heldKey(runId, caller);
    const held = this.held.get(key);
    if (held === undefined || held.size === 0 || this.inFlight.has(key)) {
      return;
    }
    const wakes = unwithdrawn(held.values());
    if (wakes.length === 0) {
      this.held.delete(key);
      return;
    }
    const { prompt, row } = joinHostWakes(wakes);
    const handedBack = (requeue: boolean): void => {
      this.inFlight.delete(key);
      if (!requeue) {
        this.owe(wakes);
        return;
      }
      const merged = new Map(wakes.map((wake) => [wake.key, wake]));
      for (const [wakeKey, later] of this.held.get(key) ?? []) {
        merged.set(wakeKey, later);
      }
      this.held.set(key, merged);
    };
    const woke = this.executor.wakeConversation(
      runId,
      caller,
      prompt,
      row,
      handedBack,
      'host',
    );
    if (woke === 'busy') {
      return;
    }
    this.held.delete(key);
    if (woke === 'refused') {
      this.owe(wakes);
      return;
    }
    this.inFlight.set(key, wakes);
  }

  /** The wakes' last attempt, which settles them: a boot never sends them again. */
  private owe(wakes: readonly HostWake[]): void {
    for (const wake of unwithdrawn(wakes)) {
      // Settled only when the note was kept: one dropped at shutdown leaves
      // the share owed, for the next boot to send.
      if (this.sessions.oweKeyNote(hostWakeSessionKey(wake.owner), wake.note)) {
        wake.onDelivered();
      }
    }
  }
}

function heldKey(runId: string, caller: string): string {
  return `${runId}\u0000${caller}`;
}
