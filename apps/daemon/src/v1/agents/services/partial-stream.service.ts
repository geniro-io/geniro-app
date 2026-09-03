import { Injectable, Logger } from '@nestjs/common';

import { type RunDeltaEvent, SINGLE_AGENT_NODE } from '../chat.types';
import { AgentEventBus } from './agent-events.bus';
import { contextWindowKey, ContextWindowStore } from './context-window.store';

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
  /**
   * The CURRENT stretch's reasoning text so far, or '' when there is none.
   *
   * Only a CLI that DISCLOSES its thinking ever fills this — claude redacts
   * the block entirely and reports a token count instead, which is why the two
   * are separate fields rather than one. Either one being present means a
   * stretch is open ({@link PartialStreamService.isReasoning}).
   */
  thinkingText: string;
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
   * (runId, ownerKey) -> the context window the CLI last reported for it.
   *
   * Remembered because the window rides the `result` line ONLY (probe-verified
   * on claude 2.1.220, and again on 2.1.x here:
   * `result.modelUsage[<model>].contextWindow`, absent from every `assistant`
   * line and from `system/init`), while the live context figure arrives
   * mid-turn. Without this the meter could show a token count with nothing to
   * scale it against until the turn finished — and a client reconnecting
   * mid-turn would see an unscaled number for the rest of it.
   *
   * Keyed by OWNER, not by run. A 1:1 chat has exactly one owner so the two are
   * the same thing there — but a workflow run is N agents that routinely run on
   * DIFFERENT models, and a run-scoped window is whichever node reported last:
   * an opus node's 160k would have been drawn against a haiku node's 200k. The
   * owner is the thing a window belongs to.
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
   * The hot half of a cache whose cold half is {@link ContextWindowStore}: a
   * miss here consults the store, which survives daemon restarts. It was
   * process-lifetime only, and that was the defect — the window rides the
   * `result` line, so a fresh process had nothing to scale against until a
   * turn COMPLETED, and every chat showed a denominator-less meter for its
   * whole first turn after each app launch.
   *
   * Still never assumed: a model neither this process nor the store has ever
   * seen stays unknown, and the meter renders the count with no ring rather
   * than measuring against a guess.
   */
  private readonly windowsByModel = new Map<string, number>();
  /**
   * (runId, ownerKey) -> the model key its current turn announced, for the
   * lookup above.
   *
   * Also what makes the owner-scoped window above INVALIDATABLE: a chat may
   * switch model between turns (the composer's chips are editable mid-run), and
   * a window learned from the previous model would otherwise be kept for the
   * whole next turn — a 300k request on a 1M model reading "300k / 200k".
   */
  private readonly runModels = new Map<
    string,
    { key: string; agent: string; model: string }
  >();

  constructor(
    private readonly bus: AgentEventBus,
    private readonly windowStore: ContextWindowStore,
  ) {}

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
      const endedAStretch = this.isReasoning(state);
      state.thinkingCurrent = null;
      state.thinkingText = '';
      if (state.text.length >= MAX_TAIL_CHARS) {
        // Publish ONLY when this delta actually changed something — i.e. it
        // ended a reasoning stretch. Publishing unconditionally here would put
        // a byte-identical 64 KB event on the wire for every remaining delta of
        // the turn, which is the exact traffic the cap exists to stop.
        if (endedAStretch) {
          this.publish(this.eventOf(runId, ownerKey, nodeId, state));
        }
        return;
      }
      state.text = (state.text + delta).slice(0, MAX_TAIL_CHARS);
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
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
      if (!this.isReasoning(state)) {
        state.thinkingStretch += 1;
        state.thinkingSince = Date.now();
      }
      state.thinkingCurrent = tokens;
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
    } catch (err) {
      this.warn('thinking', err);
    }
  }

  /**
   * Extend the CURRENT stretch's reasoning TEXT and publish it — the same
   * REPLACE semantics as {@link append}, for a CLI that discloses what it is
   * thinking rather than only how many tokens it has spent.
   *
   * It OPENS a stretch exactly as {@link thinking} does, and that is what the
   * report this exists for turned on: cursor streams thought chunks and no
   * stretch was ever opened for them, so a turn that thought for minutes drew
   * the generic `Working…` row for the whole wait — the transcript's answer
   * for an agent that has shown nothing, about an agent that was showing
   * something the whole time.
   *
   * Words WIN over thinking on the client, so the two never race for the same
   * row: this only ever fills a stretch that `append` has not already closed.
   */
  reasoning(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
    delta: string,
  ): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      const opened = !this.isReasoning(state);
      if (opened) {
        state.thinkingStretch += 1;
        state.thinkingSince = Date.now();
      }
      // Past the cap the stretch is already open and the text cannot grow, so
      // there is nothing new to say — publishing anyway would put a
      // byte-identical event on the wire for every remaining chunk, which is
      // the traffic the cap exists to stop (the same rule `append` follows).
      if (!opened && state.thinkingText.length >= MAX_TAIL_CHARS) {
        return;
      }
      state.thinkingText = (state.thinkingText + delta).slice(
        0,
        MAX_TAIL_CHARS,
      );
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
    } catch (err) {
      this.warn('reasoning', err);
    }
  }

  /**
   * Whether a reasoning stretch is open — EITHER channel counts.
   *
   * One predicate rather than a check per call site: a CLI fills one of the two
   * and never both, so a site that asked about only the token total would treat
   * a cursor stretch as closed and open a second one on its next chunk.
   */
  private isReasoning(state: LiveState): boolean {
    return state.thinkingCurrent !== null || state.thinkingText !== '';
  }

  /**
   * Report that the agent is no longer reasoning — anything else it does ends
   * the stretch.
   *
   * `append` closes a stretch too, because words arriving are the commonest way
   * one ends. They are not the only way: a model that thinks and then calls a
   * tool without saying anything first emits no delta at all, so the stretch
   * stayed open for the whole tool call and the transcript claimed the agent
   * was "Thinking… 74 tokens" while it was running Bash — measured at 3.5s on
   * one turn here, and unbounded in general (a `sleep 40` would hold it for the
   * whole command). Worse, the CLI's NEXT stretch then merged into the open one
   * instead of opening a fresh row, so its clock and its token count both
   * carried the previous wait's numbers.
   *
   * Called on every DURABLE event, which is the honest rule: the moment
   * something reaches the transcript, whatever the agent was silently doing
   * before it is over. Idempotent — a stretch that is already closed publishes
   * nothing, so calling it per event costs no traffic.
   */
  endThinking(runId: string, ownerKey: string, nodeId: string | null): void {
    try {
      const state = this.stateOf(runId, ownerKey);
      if (!this.isReasoning(state)) {
        return;
      }
      state.thinkingCurrent = null;
      state.thinkingText = '';
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
    } catch (err) {
      this.warn('endThinking', err);
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
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
    } catch (err) {
      this.warn('context', err);
    }
  }

  /**
   * Remember the window the CLI reported for this owner (from a `result` line).
   *
   * Kept per OWNER rather than per turn: the window belongs to the model, and
   * an owner's next turn is overwhelmingly the same model — so a turn's first
   * `assistant` line, which carries no window of its own, can still be scaled.
   */
  rememberWindow(
    runId: string,
    ownerKey: string,
    contextWindowTokens: number | null,
    model: string | null = null,
    contextWindow: string | null = null,
  ): void {
    try {
      if (contextWindowTokens === null || contextWindowTokens <= 0) {
        return;
      }
      const owner = this.ownerId(runId, ownerKey);
      this.windows.set(owner, contextWindowTokens);
      // Cached under the model the WINDOW ITSELF came from, never under
      // whatever the turn announced at startup. A turn that fell back to a
      // second model reports that model's window, and filing it under the
      // requested one poisons every later chat on the requested model — the
      // 1M-shown-as-200k defect, cached for the life of the process.
      const announced = this.runModels.get(owner);
      if (announced && model !== null && announced.model === model) {
        this.windowsByModel.set(announced.key, contextWindowTokens);
        // Written through to disk so the NEXT daemon launch already knows this
        // model's window at the turn's first request, instead of relearning it
        // only when a turn finishes.
        this.windowStore.remember(
          announced.agent,
          announced.model,
          contextWindowTokens,
          contextWindow,
        );
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
   * A window already remembered for THIS owner wins while the model is
   * unchanged: it came from this owner's own `result` line and so describes the
   * conversation on screen. A model CHANGE drops it — the composer's chips are
   * editable mid-run, so switching model between turns is a first-class flow,
   * and the previous model's window would otherwise scale the whole next turn.
   */
  useModel(
    runId: string,
    ownerKey: string,
    agent: string,
    model: string,
    contextWindow: string | null = null,
  ): void {
    try {
      const owner = this.ownerId(runId, ownerKey);
      const key = this.modelKey(agent, model, contextWindow);
      if (this.runModels.get(owner)?.key !== key) {
        this.runModels.set(owner, { key, agent, model });
        this.windows.delete(owner);
      }
      // A miss falls through to the persisted store — that is what makes the
      // FIRST turn after a daemon launch scaled, rather than the first turn to
      // complete in this process.
      let known = this.windowsByModel.get(key);
      if (known === undefined) {
        const stored = this.windowStore.get(agent, model, contextWindow);
        if (stored !== null) {
          this.windowsByModel.set(key, stored);
          known = stored;
        }
      }
      if (known !== undefined && !this.windows.has(owner)) {
        this.windows.set(owner, known);
      }
    } catch (err) {
      this.warn('useModel', err);
    }
  }

  /**
   * The per-model cache key, keyed by AGENT and by the turn's WINDOW CHOICE as
   * well — the exported one, so this in-memory half and the durable store
   * cannot spell it differently. See {@link contextWindowKey} for why all three
   * parts are load-bearing; the short version is that cursor's `kimi-k3` has
   * two real windows (200,000 and 1,048,576) and a key without the choice files
   * both under one entry.
   */
  private modelKey(
    agent: string,
    model: string,
    contextWindow: string | null,
  ): string {
    return contextWindowKey(agent, model, contextWindow);
  }

  /**
   * The (run, owner) key the window and model maps are filed under.
   *
   * NUL-joined like every other composite key in the daemon. A run id is a
   * UUID and an owner key is either the chat sentinel or a workflow node id, so
   * neither half can contain the byte and the pair cannot be re-partitioned.
   */
  private ownerId(runId: string, ownerKey: string): string {
    return `${runId}\u0000${ownerKey}`;
  }

  private stateOf(runId: string, ownerKey: string): LiveState {
    const byOwner = this.tails.get(runId) ?? new Map<string, LiveState>();
    this.tails.set(runId, byOwner);
    const state = byOwner.get(ownerKey) ?? {
      text: '',
      thinkingStretch: 0,
      thinkingCurrent: null,
      thinkingText: '',
      thinkingSince: null,
      contextTokens: null,
    };
    byOwner.set(ownerKey, state);
    return state;
  }

  /** Project the internal state onto the wire shape clients actually read. */
  private eventOf(
    runId: string,
    ownerKey: string,
    nodeId: string | null,
    state: LiveState,
  ): RunDeltaEvent {
    // EVERY reasoning field is null while NOT reasoning — that is what hides
    // the indicator, and publishing them as one group is what stops a client
    // seeing a stretch id without the clock that belongs to it.
    const reasoning = this.isReasoning(state);
    return {
      runId,
      nodeId,
      ownerKey,
      text: state.text,
      thinkingTokens: state.thinkingCurrent,
      // Null rather than '' when there is none, so "this CLI redacts its
      // thinking" and "this stretch has not produced a word yet" are the same
      // reading on the wire — neither has text to show.
      thinkingText: state.thinkingText === '' ? null : state.thinkingText,
      thinkingSince: reasoning ? state.thinkingSince : null,
      thinkingStretch: reasoning ? state.thinkingStretch : null,
      contextTokens: state.contextTokens,
      contextWindowTokens:
        this.windows.get(this.ownerId(runId, ownerKey)) ?? null,
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
      state.thinkingText = '';
      this.publish(this.eventOf(runId, ownerKey, nodeId, state));
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
        this.eventOf(runId, ownerKey, nodeId, {
          ...state,
          text: '',
          thinkingCurrent: null,
          thinkingText: '',
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
        // The chat's single agent uses the sentinel and publishes nodeId null;
        // a graph node uses its own id, and a CALLEE turn uses
        // `<nodeId>::<callId>` — one node can hold several calls at once, and
        // one key per node had them overwrite each other's reading.
        const nodeId =
          ownerKey === SINGLE_AGENT_NODE ? null : ownerOfKey(ownerKey);
        this.publish(
          this.eventOf(runId, ownerKey, nodeId, {
            ...state,
            text: '',
            thinkingCurrent: null,
            thinkingText: '',
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
      // Swept by PREFIX, because these two are keyed per (run, owner) and a
      // workflow run has one entry per NODE. Deleting `runId` alone was correct
      // only while every run had exactly one owner; it now leaves a node's
      // window behind for the life of the process, which is a leak that no
      // later call can reach — the run it belongs to no longer exists.
      const prefix = this.ownerId(runId, '');
      for (const key of this.windows.keys()) {
        if (key.startsWith(prefix)) {
          this.windows.delete(key);
        }
      }
      for (const key of this.runModels.keys()) {
        if (key.startsWith(prefix)) {
          this.runModels.delete(key);
        }
      }
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

/**
 * The NODE an owner key belongs to — the key itself for a node's own turn, and
 * the part before `::` for a callee turn's per-call key.
 *
 * The two used to be the same string, and that is exactly what made a node's
 * concurrent calls share one reading: the last writer won, so a caller running
 * two of the same callee saw one ring flickering between two unrelated
 * conversations. The key is per CALL now and this is the one place the node is
 * read back out of it.
 */
export function ownerOfKey(ownerKey: string): string {
  const split = ownerKey.indexOf(OWNER_KEY_SEPARATOR);
  return split === -1 ? ownerKey : ownerKey.slice(0, split);
}

/**
 * Separator between a node id and the call id in a per-call owner key.
 *
 * TWIN PARSER: `apps/ui/src/renderer/chats/live-text.ts` re-implements this
 * constant and both directions around it. The key rides `agent_delta`, which is
 * deliberately outside the generated HTTP contract, so the renderer has no
 * generated type to read it with — a change here MUST be mirrored there, or the
 * call threads' context rings blank with nothing failing to compile.
 */
export const OWNER_KEY_SEPARATOR = '::';

/** The live-plane owner key for one node's turn, or one of its CALL threads. */
export function partialOwnerKey(nodeId: string, callId: string | null): string {
  return callId === null ? nodeId : `${nodeId}${OWNER_KEY_SEPARATOR}${callId}`;
}
