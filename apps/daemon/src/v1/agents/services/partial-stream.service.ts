import { Injectable, Logger } from '@nestjs/common';

import { type RunDeltaEvent, SINGLE_AGENT_NODE } from '../chat.types';
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
   * How many reasoning stretches this turn has OPENED, counting from 1.
   *
   * The number itself means nothing to a reader — it exists so a client can
   * tell one stretch from the next. A turn reasons, writes, reasons again;
   * without an identity on the wire those two stretches are indistinguishable
   * from one long one, and a renderer showing "thinking" has no way to know it
   * should start a fresh row with a fresh clock rather than keep growing the
   * old one.
   */
  thinkingStretch: number;
  /** The CURRENT stretch's running total, or null when not reasoning. */
  thinkingCurrent: number | null;
  /** When the CURRENT stretch began (epoch ms), or null when not reasoning. */
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
  /**
   * model id -> the window that model reported, learned from any run.
   *
   * The per-RUN map above cannot help a run's FIRST turn: the window rides the
   * `result` line only, so until one turn finished there was nothing to scale
   * against and the meter fell back to an assumed 200k — which is how a
   * 1M-window model came to be shown as a fifth full before it had said
   * anything. A window is a property of the MODEL, not of the conversation, so
   * remembering it by model makes every later chat on that model correct from
   * its first request.
   *
   * Process-lifetime only, and deliberately so: it is a cache of something the
   * CLI will report again, never a source of truth. A model whose window has
   * not been observed this session stays unknown rather than assumed.
   */
  private readonly windowsByModel = new Map<string, number>();
  /**
   * runId -> the model key its current turn announced, for the lookup above.
   *
   * Also what makes the run-scoped window above INVALIDATABLE: a chat may
   * switch model between turns (the composer's chips are editable mid-run), and
   * a window learned from the previous model would otherwise be kept for the
   * whole next turn — a 300k request on a 1M model reading "300k / 200k".
   */
  private readonly runModels = new Map<
    string,
    { key: string; model: string }
  >();

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
      //
      // Closed BEFORE the cap check, not after: the cap stops the tail from
      // growing, not the turn from progressing. Returning first left the
      // stretch open forever once a turn crossed 64 KB, so the "thinking" row
      // never cleared for that agent again — the exact defect this plane was
      // reworked to fix.
      const endedAStretch = state.thinkingCurrent !== null;
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
      // A null current total means no stretch is open, so this delta OPENS one:
      // new identity, new clock. Both are per stretch rather than per turn
      // because a stretch is what the user is watching — a turn that thinks,
      // runs three tools, then thinks again is two separate waits, and showing
      // the first one's clock still running through the second read as a
      // counter that never resets under rows that kept piling up above it.
      if (state.thinkingCurrent === null) {
        state.thinkingStretch += 1;
        state.thinkingSince = Date.now();
      }
      state.thinkingCurrent = tokens;
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
  rememberWindow(
    runId: string,
    contextWindowTokens: number | null,
    model: string | null = null,
  ): void {
    try {
      if (contextWindowTokens === null || contextWindowTokens <= 0) {
        return;
      }
      this.windows.set(runId, contextWindowTokens);
      // Cached under the model the WINDOW ITSELF came from, never under
      // whatever the turn announced at startup. A turn that fell back to a
      // second model reports that model's window, and filing it under the
      // requested one poisons every later chat on the requested model — the
      // 1M-shown-as-200k defect, cached for the life of the process.
      const announced = this.runModels.get(runId);
      if (announced && model !== null && announced.model === model) {
        this.windowsByModel.set(announced.key, contextWindowTokens);
      }
    } catch (err) {
      this.warn('rememberWindow', err);
    }
  }

  /**
   * The turn named the model it is running as — apply that model's window if
   * one has been seen before, so the meter is scaled from the FIRST request
   * rather than from the first completed turn.
   *
   * A window already remembered for THIS run wins while the model is
   * unchanged: it came from this run's own `result` line and so describes the
   * conversation on screen. A model CHANGE drops it — the composer's chips are
   * editable mid-run, so switching model between turns is a first-class flow,
   * and the previous model's window would otherwise scale the whole next turn.
   */
  useModel(runId: string, agent: string, model: string): void {
    try {
      const key = this.modelKey(agent, model);
      if (this.runModels.get(runId)?.key !== key) {
        this.runModels.set(runId, { key, model });
        this.windows.delete(runId);
      }
      const known = this.windowsByModel.get(key);
      if (known !== undefined && !this.windows.has(runId)) {
        this.windows.set(runId, known);
      }
    } catch (err) {
      this.warn('useModel', err);
    }
  }

  /**
   * The per-model cache key, keyed by AGENT as well.
   *
   * Two CLIs can name the same model, and a window measured through one says
   * nothing about the other — `.claude/rules/agent-adapters.md` states the rule
   * flatly: per-agent state is keyed by agent, never by the thing it is about.
   * Only claude reports a window today, so nothing collides yet; that is an
   * accident of which adapter emits the event, not a property of the key.
   */
  private modelKey(agent: string, model: string): string {
    return `${agent} ${model}`;
  }

  private stateOf(runId: string, ownerKey: string): LiveState {
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    this.tails.set(runId, byOwner);
    const state = byOwner.get(ownerKey) ?? {
      text: '',
      thinkingStretch: 0,
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
    // All three reasoning fields are null while NOT reasoning — that is what
    // hides the indicator, and publishing them as one group is what stops a
    // client seeing a stretch id without the clock that belongs to it.
    const reasoning = state.thinkingCurrent !== null;
    return {
      runId,
      nodeId,
      text: state.text,
      thinkingTokens: state.thinkingCurrent,
      thinkingSince: reasoning ? state.thinkingSince : null,
      thinkingStretch: reasoning ? state.thinkingStretch : null,
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
   * The turn-scoped accounting SURVIVES: the stretch counter and the context
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
  takeTail(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
  ): string | null {
    try {
      const state = this.tails.get(runId)?.get(ownerKey);
      const tail = state?.text ?? '';
      if (!state || !tail) {
        return null;
      }
      this.tails.get(runId)?.delete(ownerKey);
      // Announced, not merely forgotten. These words are about to be written as
      // a durable `partial` item; without an event saying the live copy is gone
      // the client keeps rendering it too, and the user reads the same
      // half-sentence twice — once as the tail they watched appear, once as the
      // row written to replace it.
      this.publish(
        this.eventOf(runId, nodeId, {
          ...state,
          text: '',
          thinkingCurrent: null,
        }),
      );
      return tail;
    } catch (err) {
      this.warn('takeTail', err);
      return null;
    }
  }

  /**
   * Forget a whole run's live state (its turn settled, or the run is
   * terminal). This is the TURN boundary, so it is what resets the stretch
   * counter — the next turn starts counting its stretches from one.
   *
   * It ANNOUNCES the clear before forgetting it, one empty event per owner.
   * Deleting the state locally says nothing on the wire, so the client stayed
   * on whatever the last delta claimed: the words `takeTail` just handed to a
   * durable `partial` item rendered a second time as a live tail, and a
   * reasoning stretch that was open when the turn stopped kept a "Thinking…"
   * row whose clock ticked on under a settled chat. The whole point of
   * publishing the WHOLE tail is that the last event is authoritative — so
   * the last event has to be the empty one.
   *
   * The remembered context window deliberately survives: it describes the
   * model, not the turn, and the next turn's first `assistant` line needs it
   * before any `result` line could supply one.
   */
  clearRun(runId: string): void {
    try {
      const byOwner = this.tails.get(runId);
      this.tails.delete(runId);
      if (!byOwner) {
        return;
      }
      for (const [ownerKey, state] of byOwner) {
        // Owner keys and node ids coincide for every producer of this plane:
        // the chat's single agent uses the sentinel and publishes nodeId null,
        // a graph node uses its own id for both.
        const nodeId = ownerKey === SINGLE_AGENT_NODE ? null : ownerKey;
        this.publish(
          this.eventOf(runId, nodeId, {
            ...state,
            text: '',
            thinkingCurrent: null,
          }),
        );
      }
    } catch (err) {
      this.warn('clearRun', err);
    }
  }

  /**
   * Drop everything remembered for a run — used when the run itself is gone.
   *
   * The per-MODEL windows survive: they describe models, not this run, and a
   * deleted chat is no reason for the next one to start guessing again.
   */
  forgetRun(runId: string): void {
    try {
      this.tails.delete(runId);
      this.windows.delete(runId);
      this.runModels.delete(runId);
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
