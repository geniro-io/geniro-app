import { Injectable, Logger } from '@nestjs/common';

import type { RunDeltaEvent } from '../chat.types';
import { AgentEventBus } from './agent-events.bus';

/**
 * Hard cap on one owner's live tail. A runaway block stops growing rather than
 * pushing an unbounded string across the wire on every delta; the durable
 * `message` item that follows carries the full text regardless.
 */
const MAX_TAIL_CHARS = 64 * 1024;

/** What one agent is doing right now — the whole of the ephemeral state. */
interface LiveState {
  /** Words streamed since that agent's last durable item. */
  text: string;
  /** Reasoning tokens so far, or null when not thinking. */
  thinkingTokens: number | null;
}

/**
 * The live (non-persisted) text plane behind a growing assistant bubble.
 *
 * Deltas are EPHEMERAL by contract — no `seq`, no row, no replay — so this
 * service holds the only copy of the not-yet-persisted tail. It exists to do
 * three things and nothing else:
 *
 * - **accumulate** each delta into the current tail and publish the whole tail
 *   (REPLACE semantics, never an increment) so a client that missed a delta is
 *   correct again on the very next one;
 * - **retire** the tail the moment the durable `message` item for those same
 *   words is persisted, so nothing is ever rendered twice;
 * - **flush** whatever is left when a turn dies mid-block, as ONE
 *   `partial`-flagged message item, so an `afterSeq` replay shows the user the
 *   text they actually watched being written.
 *
 * Every public method is total: this plane is a nicety layered over the
 * durable one, and a failure here must never fail a turn (its callers run
 * inside the persist chain, where a throw would mark the run failed).
 */
@Injectable()
export class PartialStreamService {
  private readonly logger = new Logger(PartialStreamService.name);
  /** runId -> ownerKey -> what that agent is doing right now. */
  private readonly tails = new Map<string, Map<string, LiveState>>();

  constructor(private readonly bus: AgentEventBus) {}

  /** Extend an owner's tail and publish it. */
  append(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
    delta: string,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      if (state.text.length >= MAX_TAIL_CHARS) {
        return;
      }
      state.text = (state.text + delta).slice(0, MAX_TAIL_CHARS);
      // Words are arriving, so the reasoning stretch is over — otherwise the
      // indicator would sit under the growing text for the rest of the turn.
      state.thinkingTokens = null;
      this.publish({ runId, nodeId, ...state });
    } catch (err) {
      this.warn('append', err);
    }
  }

  /** Report that the model is reasoning, with its running token total. */
  thinking(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
    tokens: number,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      state.thinkingTokens = tokens;
      this.publish({ runId, nodeId, ...state });
    } catch (err) {
      this.warn('thinking', err);
    }
  }

  private stateOf(runId: string, ownerKey: string): LiveState {
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    this.tails.set(runId, byOwner);
    const state = byOwner.get(ownerKey) ?? { text: '', thinkingTokens: null };
    byOwner.set(ownerKey, state);
    return state;
  }

  /**
   * The durable item for this owner's current block has landed — drop the tail
   * and tell clients to stop showing it. Called for every persisted item, so
   * a tool call or an error retires a dangling tail too.
   */
  retire(runId: string, ownerKey: string, nodeId: string | null): void {
    try {
      const byOwner = this.tails.get(runId);
      if (!byOwner?.has(ownerKey)) {
        return;
      }
      byOwner.delete(ownerKey);
      if (byOwner.size === 0) {
        this.tails.delete(runId);
      }
      this.publish({ runId, nodeId, text: '', thinkingTokens: null });
    } catch (err) {
      this.warn('retire', err);
    }
  }

  /**
   * Whatever an owner streamed but never got a durable item for — the text to
   * persist as ONE partial-flagged message when a turn cancels or fails. The
   * tail is consumed, so a second call yields nothing and the flush can never
   * be written twice.
   */
  takeTail(runId: string, ownerKey: string): string | null {
    try {
      const tail = this.tails.get(runId)?.get(ownerKey)?.text ?? '';
      if (!tail) {
        return null;
      }
      this.tails.get(runId)?.delete(ownerKey);
      return tail;
    } catch (err) {
      this.warn('takeTail', err);
      return null;
    }
  }

  /** Forget a whole run (its last turn settled, or the run is terminal). */
  clearRun(runId: string): void {
    try {
      this.tails.delete(runId);
    } catch (err) {
      this.warn('clearRun', err);
    }
  }

  private publish(event: RunDeltaEvent): void {
    this.bus.publishDelta(event);
  }

  private warn(where: string, err: unknown): void {
    this.logger.warn(
      `live stream ${where} failed (the durable transcript is unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
