import { Injectable, Logger } from '@nestjs/common';

import type { HostRowWire, HostWake } from '../chat.types';
import { callSessionKey, nodeSessionKey } from '../utils/session-keys';

/**
 * Wakes an agent about work geniro did for it outside its turn — a share
 * that waited on the user's sign-in — the way a monitor's output wakes it,
 * but outside the monitor machinery: these wakes count against no monitor
 * limit and are held by their own deliveries (`HostWakeChatDelivery`,
 * `HostWakeGraphDelivery`).
 *
 * A leaf, so a module above `v1/agents` (shares) can publish without
 * importing the graph engine that delivers to a team.
 */
@Injectable()
export class HostWakeBus {
  private readonly logger = new Logger(HostWakeBus.name);
  private readonly listeners = new Set<(wake: HostWake) => void>();

  publish(wake: HostWake): void {
    for (const listener of this.listeners) {
      try {
        listener(wake);
      } catch (err) {
        this.logger.error(
          `host wake ${wake.key} listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  subscribe(listener: (wake: HostWake) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** The session key a wake's note is owed under: a chat's run, a node, or a callee conversation. */
export function hostWakeSessionKey(owner: HostWake['owner']): string {
  if (owner.target === 'chat') {
    return owner.runId;
  }
  return owner.conversationId === null
    ? nodeSessionKey(owner.runId, owner.nodeId)
    : callSessionKey(owner.runId, owner.conversationId);
}

/** The wakes still allowed to go out; a withdrawn one is dropped unsent. */
export function unwithdrawn(wakes: Iterable<HostWake>): HostWake[] {
  return [...wakes].filter((wake) => wake.withdrawn?.() !== true);
}

/** Several wakes for one conversation, as the one turn they open. */
export function joinHostWakes(wakes: readonly HostWake[]): {
  prompt: string;
  row: HostRowWire;
} {
  return {
    prompt: wakes.map((wake) => wake.prompt).join('\n\n'),
    row: {
      severity: 'info',
      message: [...new Set(wakes.map((wake) => wake.row.message))].join(' '),
      shares: wakes.flatMap((wake) => wake.row.shares ?? []),
      woke: true,
    },
  };
}
