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
  /**
   * Reasoning tokens from stretches of THIS TURN that have already ended.
   *
   * The CLI's `estimated_tokens` is a running total per reasoning STRETCH, not
   * per turn, so a turn that thinks, writes, then thinks again reports a fresh
   * count the second time. Carrying the finished stretches here is what makes
   * the number the user sees cumulative over the turn instead of restarting
   * every time the agent pauses to type.
   */
  thinkingBase: number;
  /** The CURRENT stretch's running total, or null when not reasoning. */
  thinkingCurrent: number | null;
  /** When this turn's FIRST reasoning began (epoch ms), or null. */
  thinkingSince: number | null;
  /** Prompt-side tokens as of the turn's most recent request, or null. */
  contextTokens: number | null;
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
  /**
   * runId -> the context window the CLI last reported for this run.
   *
   * Remembered because the window rides the `result` line ONLY (probe-verified
   * on claude 2.1.220: `result.modelUsage[<model>].contextWindow`, absent from
   * every `assistant` line), while the live context figure arrives mid-turn.
   * Without this the meter could show a token count with nothing to scale it
   * against until the turn finished — and a client reconnecting mid-turn would
   * see an unscaled number for the rest of it.
   */
  private readonly windows = new Map<string, number>();

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
      // Words are arriving, so the reasoning STRETCH is over — otherwise the
      // indicator would sit under the growing text for the rest of the turn.
      // Its tokens are banked rather than discarded: the turn's total is what
      // the user is being shown, and it must not restart at the next pause.
      //
      // Banked BEFORE the cap check, not after: the cap stops the tail from
      // growing, not the turn from progressing. Returning first left the
      // stretch open forever once a turn crossed 64 KB, so the "thinking" row
      // never cleared for that agent again — the exact defect this plane was
      // reworked to fix.
      const endedAStretch = state.thinkingCurrent !== null;
      state.thinkingBase += state.thinkingCurrent ?? 0;
      state.thinkingCurrent = null;
      if (state.text.length >= MAX_TAIL_CHARS) {
        // Publish ONLY when this delta actually changed something — i.e. it
        // ended a reasoning stretch. Publishing unconditionally here would put
        // a byte-identical 64 KB event on the wire for every remaining delta of
        // the turn, which is the exact traffic the cap exists to stop.
        if (endedAStretch) {
          this.publish(this.eventOf(runId, nodeId, state));
        }
        return;
      }
      state.text = (state.text + delta).slice(0, MAX_TAIL_CHARS);
      this.publish(this.eventOf(runId, nodeId, state));
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
      state.thinkingCurrent = tokens;
      // Elapsed is measured from the turn's FIRST reasoning, so it reads as
      // "how long this turn has been thinking" rather than resetting to zero
      // every time the agent breaks off to write a sentence.
      state.thinkingSince ??= Date.now();
      this.publish(this.eventOf(runId, nodeId, state));
    } catch (err) {
      this.warn('thinking', err);
    }
  }

  /**
   * Report how full the window is as of the turn's most recent request.
   *
   * Mid-turn, unlike the `turn_complete` figure the meter used to wait for:
   * every `assistant` line carries its request's prompt-side usage, so the
   * meter can move while the turn runs instead of jumping once at the end.
   */
  context(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
    contextTokens: number,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      state.contextTokens = contextTokens;
      this.publish(this.eventOf(runId, nodeId, state));
    } catch (err) {
      this.warn('context', err);
    }
  }

  /**
   * Remember the window the CLI reported for this run (from a `result` line).
   *
   * Kept per RUN rather than per owner: the window belongs to the model, and a
   * run's next turn is overwhelmingly the same model — so a turn's first
   * `assistant` line, which carries no window of its own, can still be scaled.
   */
  rememberWindow(runId: string, contextWindowTokens: number | null): void {
    try {
      if (contextWindowTokens !== null && contextWindowTokens > 0) {
        this.windows.set(runId, contextWindowTokens);
      }
    } catch (err) {
      this.warn('rememberWindow', err);
    }
  }

  private stateOf(runId: string, ownerKey: string): LiveState {
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    this.tails.set(runId, byOwner);
    const state = byOwner.get(ownerKey) ?? {
      text: '',
      thinkingBase: 0,
      thinkingCurrent: null,
      thinkingSince: null,
      contextTokens: null,
    };
    byOwner.set(ownerKey, state);
    return state;
  }

  /** Project the internal state onto the wire shape clients actually read. */
  private eventOf(
    runId: string,
    nodeId: string | null,
    state: LiveState,
  ): RunDeltaEvent {
    return {
      runId,
      nodeId,
      text: state.text,
      // Null while NOT reasoning — that is what hides the indicator. The
      // banked total is deliberately not shown between stretches: there is no
      // "thinking" row to put it in.
      thinkingTokens:
        state.thinkingCurrent === null
          ? null
          : state.thinkingBase + state.thinkingCurrent,
      thinkingSince:
        state.thinkingCurrent === null ? null : state.thinkingSince,
      contextTokens: state.contextTokens,
      contextWindowTokens: this.windows.get(runId) ?? null,
    };
  }

  /**
   * The durable item for this owner's current block has landed — drop the tail
   * and tell clients to stop showing it.
   *
   * ONLY a `message` retires: its caller gates on `mapped.kind === 'message'`
   * precisely so a tool call cannot wipe the tail of words the agent is still
   * writing. (The doc block here used to describe the opposite — a retire for
   * every persisted item — which the caller has never done.)
   *
   * The turn-scoped accounting SURVIVES: a turn's thinking total and context
   * figure belong to the turn, not to one block of its text, and a turn
   * routinely lands several messages. `clearRun` is what ends the turn.
   */
  retire(runId: string, ownerKey: string, nodeId: string | null): void {
    try {
      const state = this.tails.get(runId)?.get(ownerKey);
      if (!state) {
        return;
      }
      state.text = '';
      state.thinkingBase += state.thinkingCurrent ?? 0;
      state.thinkingCurrent = null;
      this.publish(this.eventOf(runId, nodeId, state));
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

  /**
   * Forget a whole run's live state (its turn settled, or the run is
   * terminal). This is the TURN boundary, so it is what resets the thinking
   * accumulation — the next turn starts counting from zero.
   *
   * The remembered context window deliberately survives: it describes the
   * model, not the turn, and the next turn's first `assistant` line needs it
   * before any `result` line could supply one.
   */
  clearRun(runId: string): void {
    try {
      this.tails.delete(runId);
    } catch (err) {
      this.warn('clearRun', err);
    }
  }

  /** Drop everything remembered for a run — used when the run itself is gone. */
  forgetRun(runId: string): void {
    try {
      this.tails.delete(runId);
      this.windows.delete(runId);
    } catch (err) {
      this.warn('forgetRun', err);
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
