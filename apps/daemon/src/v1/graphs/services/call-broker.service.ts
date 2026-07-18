import { Injectable } from '@nestjs/common';

import type {
  CalleeTurnOutcome,
  CallEnvelope,
  CallMode,
  ParkQuestionInput,
  RunCallCapability,
  WorkflowAgentNode,
} from '../graphs.types';

/** The run has no live call surface — reused by call_agent and await_agent. */
const RUN_NOT_ACTIVE: CallEnvelope = {
  status: 'error',
  error: 'RUN_NOT_ACTIVE: this run is not accepting agent calls',
};

/**
 * Call-chain depth cap: a DAG-launched caller sits at depth 0, its callee at
 * 1, a call made BY that callee lands at 2… — 3 keeps A→B→C legal while
 * braking runaway mutual-call loops (which the total-turns cap hard-stops).
 */
const MAX_CALL_DEPTH = 3;

/** Hard per-run stop on callee turns — the runaway-loop backstop. */
const MAX_CALL_TURNS_PER_RUN = 50;

/**
 * How long a parked question may wait for answer_agent before the call fails
 * with QUESTION_TIMEOUT. Generous by design — the caller may be escalating to
 * a human through its own question card.
 */
const QUESTION_TTL_MS = 5 * 60_000;

interface AsyncCallEntry {
  /** The caller that started the call — only it may collect the result. */
  owner: string;
  settled: Promise<CallEnvelope>;
}

/** A parked mid-turn question — the callee is blocked on answer_agent. */
interface ParkedQuestion {
  question: string;
  options: string[];
  timer: NodeJS.Timeout;
  deliver(answer: string): boolean;
  fail(): void;
}

interface ActiveCall {
  calleeId: string;
  /** The caller that started the call — only it may answer or collect. */
  owner: string;
  depth: number;
  /** Fire-and-forget calls orphan their questions — nobody ever collects. */
  mode: CallMode;
  /** The FINAL envelope (call_result persisted) — never a question. */
  settled: Promise<CallEnvelope>;
  parked: ParkedQuestion | null;
  /** Sync/await waiters diverted early when a question parks mid-wait. */
  questionWaiters: ((envelope: CallEnvelope) => void)[];
  /**
   * Set BEFORE fail() cancels a parked turn (TTL / orphan drain) so the final
   * envelope carries the typed error instead of a generic CALLEE_CANCELLED.
   */
  failReason: string | null;
}

/**
 * One settled call's conversation handle: `call_agent` with
 * `thread: <call_id>` resumes this record's callee CLI session, continuing
 * the conversation instead of starting fresh. Retained for the run's whole
 * life (bounded by the per-run turn cap) so any earlier point of a
 * conversation can be continued.
 */
interface ThreadRecord {
  /** The caller that made the call — only it may continue the thread. */
  owner: string;
  calleeId: string;
  /** The resumable CLI session; null = the turn recorded none. */
  sessionId: string | null;
}

interface RunCallState {
  capability: RunCallCapability;
  callSeq: number;
  turnsStarted: number;
  /** Live callee turns keyed by call id. */
  activeCalls: Map<string, ActiveCall>;
  /** Results retained until their caller collects them via await_agent. */
  pendingAsync: Map<string, AsyncCallEntry>;
  /** Settled calls' resume handles keyed by call id (thread continuation). */
  threads: Map<string, ThreadRecord>;
}

/**
 * Agent-to-agent call semantics over the executor's capability seam: call
 * ids, the depth and total-turns caps, sync waiting, async + await_agent
 * collection, fire-and-forget, and the Q&A bridge's parked-question
 * lifecycle (park → answer_agent / TTL / orphan drain). One instance serves
 * every run; state is per-run and dies with `unregisterRun` (in-memory only —
 * a call never outlives its run). Modeled on ApprovalRegistry's pending
 * round-trip.
 */
@Injectable()
export class CallBroker {
  private readonly runs = new Map<string, RunCallState>();

  /** The executor announces a run whose workflow carries call edges. */
  registerRun(runId: string, capability: RunCallCapability): void {
    this.runs.set(runId, {
      capability,
      callSeq: 0,
      turnsStarted: 0,
      activeCalls: new Map(),
      pendingAsync: new Map(),
      threads: new Map(),
    });
  }

  /** Drop a settled run's state (uncollected async results included). */
  unregisterRun(runId: string): void {
    const state = this.runs.get(runId);
    if (state) {
      // A parked timer must not fire into a dead run (the executor already
      // cancelled every callee handle on the way here).
      for (const call of state.activeCalls.values()) {
        if (call.parked) {
          clearTimeout(call.parked.timer);
          call.parked = null;
        }
      }
    }
    this.runs.delete(runId);
  }

  /** Callees `callerNodeId` may invoke — [] when unknown or unwired. */
  listCallees(
    runId: string,
    callerNodeId: string,
  ): readonly WorkflowAgentNode[] {
    return this.runs.get(runId)?.capability.calleesOf.get(callerNodeId) ?? [];
  }

  /** True while the run is registered (its MCP endpoint is live). */
  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * The call_agent tool. Sync resolves with the callee's settled envelope OR
   * an early `question` envelope when the callee parks mid-turn (the call
   * then becomes await_agent-collectable); async/fire-and-forget resolve
   * immediately with `{ call_id, state }` — async results are retained for
   * await_agent, fire-and-forget results go to the transcript only.
   */
  async callAgent(
    runId: string,
    callerNodeId: string,
    args: { agent: string; message: string; mode?: CallMode; thread?: string },
  ): Promise<CallEnvelope> {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    if (state.capability.isCancelled()) {
      return {
        status: 'error',
        error: 'RUN_CANCELLED: the run was cancelled — no new calls',
      };
    }
    const callees = state.capability.calleesOf.get(callerNodeId) ?? [];
    const callee = resolveCallee(callees, args.agent);
    if (!callee) {
      const wired = callees.map((c) => c.name ?? c.id).join(', ') || 'none';
      return {
        status: 'error',
        error: `UNKNOWN_AGENT: '${args.agent}' is not call-wired to you (callable: ${wired})`,
      };
    }
    const depth = this.callerDepth(state, callerNodeId) + 1;
    if (depth > MAX_CALL_DEPTH) {
      return {
        status: 'error',
        error: `DEPTH_LIMIT: call chains are capped at depth ${MAX_CALL_DEPTH}`,
      };
    }
    if (state.turnsStarted >= MAX_CALL_TURNS_PER_RUN) {
      return {
        status: 'error',
        error: `TURN_LIMIT: this run already started ${MAX_CALL_TURNS_PER_RUN} callee turns`,
      };
    }
    // Thread continuation: resume the callee CLI session a prior call of THIS
    // caller recorded. Ownership gates the lookup like await/answer do — one
    // caller can never continue (and thus read) another caller's conversation.
    let resumeSessionId: string | null = null;
    if (args.thread !== undefined) {
      const thread = state.threads.get(args.thread);
      if (!thread || thread.owner !== callerNodeId) {
        return {
          status: 'error',
          error: `UNKNOWN_THREAD: no settled call '${args.thread}' started by you`,
        };
      }
      if (thread.calleeId !== callee.id) {
        return {
          status: 'error',
          error: `THREAD_AGENT_MISMATCH: call '${args.thread}' was a conversation with '${thread.calleeId}', not '${callee.id}'`,
        };
      }
      if (!thread.sessionId) {
        return {
          status: 'error',
          error: `THREAD_UNAVAILABLE: call '${args.thread}' recorded no resumable session`,
        };
      }
      resumeSessionId = thread.sessionId;
    }
    state.turnsStarted += 1;
    state.callSeq += 1;
    const callId = `call-${state.callSeq}`;
    const mode: CallMode = args.mode ?? 'sync';
    const call: ActiveCall = {
      calleeId: callee.id,
      owner: callerNodeId,
      depth,
      mode,
      settled: Promise.resolve(RUN_NOT_ACTIVE), // reassigned synchronously below
      parked: null,
      questionWaiters: [],
      failReason: null,
    };
    state.activeCalls.set(callId, call);
    state.capability.persistItem(callerNodeId, 'call_started', null, {
      callId,
      callerNodeId,
      calleeNodeId: callee.id,
      mode,
      message: args.message,
      ...(args.thread !== undefined ? { thread: args.thread } : {}),
    });

    // The settled turn's CLI session id, mirrored into the call_result item so
    // the UI can open a terminal on (or reason about) that specific thread.
    let threadSessionId: string | null = null;
    call.settled = state.capability
      .launchCalleeTurn(callee, args.message, callId, depth, resumeSessionId)
      .then((outcome) => {
        // Every settled turn leaves a resume handle so the conversation can
        // be continued from THIS point with `thread: <this call_id>`.
        state.threads.set(callId, {
          owner: callerNodeId,
          calleeId: callee.id,
          sessionId: outcome.sessionId,
        });
        threadSessionId = outcome.sessionId;
        return toEnvelope(callId, callee.id, outcome);
      })
      .catch((err: unknown): CallEnvelope => ({
        status: 'error',
        error: `CALL_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((envelope) => {
        // A TTL/orphan drain cancelled the parked turn — surface its typed
        // reason, not the generic CALLEE_CANCELLED the cancel maps to.
        const final: CallEnvelope = call.failReason
          ? { status: 'error', error: call.failReason }
          : envelope;
        if (call.parked) {
          // The turn died with a question still parked (external cancel,
          // crash) — the timer must not fire into a settled call.
          clearTimeout(call.parked.timer);
          call.parked = null;
        }
        state.activeCalls.delete(callId);
        state.capability.persistItem(callerNodeId, 'call_result', null, {
          callId,
          callerNodeId,
          calleeNodeId: callee.id,
          mode,
          sessionId: threadSessionId,
          ...final,
        });
        return final;
      });

    if (mode === 'sync') {
      return this.waitForOutcome(state, callId, call.settled);
    }
    if (mode === 'async') {
      state.pendingAsync.set(callId, {
        owner: callerNodeId,
        settled: call.settled,
      });
    }
    return {
      status: 'ok',
      result: {
        call_id: callId,
        agent: callee.id,
        state: mode === 'async' ? 'started' : 'detached',
      },
    };
  }

  /**
   * The await_agent tool: collect one of the caller's own async (or
   * question-parked sync) results. Returns an early `question` envelope when
   * the callee parks mid-wait — the entry stays collectable for the retry
   * after answer_agent.
   */
  async awaitAgent(
    runId: string,
    callerNodeId: string,
    args: { call_id: string },
  ): Promise<CallEnvelope> {
    const state = this.runs.get(runId);
    if (!state) {
      return {
        status: 'error',
        error: 'RUN_NOT_ACTIVE: this run is not accepting agent calls',
      };
    }
    const entry = state.pendingAsync.get(args.call_id);
    if (!entry || entry.owner !== callerNodeId) {
      return {
        status: 'error',
        error: `UNKNOWN_CALL: no un-collected async call '${args.call_id}' started by you`,
      };
    }
    const envelope = await this.waitForOutcome(
      state,
      args.call_id,
      entry.settled,
    );
    if (envelope.status === 'question') {
      return envelope;
    }
    // A concurrent waiter may have collected while this one was blocked —
    // collection stays exactly-once (question envelopes are the only
    // non-consuming reads), so the loser is told the call is gone rather
    // than duplicating the await_collected row.
    if (!state.pendingAsync.has(args.call_id)) {
      return {
        status: 'error',
        error: `UNKNOWN_CALL: no un-collected async call '${args.call_id}' started by you`,
      };
    }
    state.pendingAsync.delete(args.call_id);
    state.capability.persistItem(callerNodeId, 'await_collected', null, {
      callId: args.call_id,
      callerNodeId,
    });
    return envelope;
  }

  /**
   * The answer_agent tool (M4): deliver the caller's answer into its parked
   * callee turn. Ownership is per caller node — a callee child can never
   * answer a question it did not cause its own callee to raise.
   */
  answerAgent(
    runId: string,
    callerNodeId: string,
    args: { call_id: string; answer: string },
  ): CallEnvelope {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const call = state.activeCalls.get(args.call_id);
    if (!call || call.owner !== callerNodeId) {
      return {
        status: 'error',
        error: `UNKNOWN_CALL: no live call '${args.call_id}' started by you`,
      };
    }
    const parked = call.parked;
    if (!parked) {
      return {
        status: 'error',
        error: `NO_QUESTION: call '${args.call_id}' has no outstanding question (already answered, or still running)`,
      };
    }
    call.parked = null;
    clearTimeout(parked.timer);
    if (!parked.deliver(args.answer)) {
      // The question row must not dangle unresolved in the transcript even
      // when the callee died under it.
      state.capability.persistItem(call.owner, 'call_answer', null, {
        callId: args.call_id,
        callerNodeId,
        calleeNodeId: call.calleeId,
        outcome: 'undelivered',
      });
      return {
        status: 'error',
        error:
          'DELIVERY_FAILED: the callee turn ended before the answer arrived',
      };
    }
    state.capability.persistItem(call.owner, 'call_answer', null, {
      callId: args.call_id,
      callerNodeId,
      calleeNodeId: call.calleeId,
      answer: args.answer,
      outcome: 'answered',
    });
    return {
      status: 'ok',
      result: { call_id: args.call_id, state: 'answered' },
    };
  }

  /**
   * Park a callee's mid-turn question (M4): the executor's capture seam calls
   * this instead of tracking a renderer approval. False when the call is
   * unknown/settled or already parked — the executor then denies the request
   * so the callee continues instead of hanging.
   */
  parkQuestion(
    runId: string,
    callId: string,
    input: ParkQuestionInput,
  ): boolean {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call || call.parked) {
      return false;
    }
    const timer = setTimeout(
      () => this.expireQuestion(runId, callId),
      input.ttlMs ?? QUESTION_TTL_MS,
    );
    timer.unref?.();
    call.parked = {
      question: input.question,
      options: input.options,
      timer,
      deliver: input.deliver,
      fail: input.fail,
    };
    state.capability.persistItem(call.owner, 'call_question', null, {
      callId,
      callerNodeId: call.owner,
      calleeNodeId: call.calleeId,
      question: input.question,
      options: input.options,
      payload: input.payload,
    });
    // Nobody can ever answer_agent this question: a fire-and-forget caller
    // never sees envelopes, and a settled owner raced the park past its
    // drainCaller sweep. Orphan NOW instead of grinding through the TTL with
    // the run held open (the question row above still shows what was asked).
    if (
      call.mode === 'fire_and_forget' ||
      !state.capability.isNodeLive(call.owner)
    ) {
      this.failParked(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
        'orphaned',
      );
      return true;
    }
    // A sync call that parks becomes await_agent-collectable — its caller got
    // the question envelope in place of the final result.
    if (!state.pendingAsync.has(callId)) {
      state.pendingAsync.set(callId, {
        owner: call.owner,
        settled: call.settled,
      });
    }
    const envelope = questionEnvelope(callId, call);
    for (const notify of call.questionWaiters.splice(0)) {
      notify(envelope);
    }
    return true;
  }

  /**
   * Fail every parked question owned by a settling caller — nobody is left
   * to answer it (the executor calls this when a caller node's LAST live
   * turn settles, next to its approval sweep).
   */
  drainCaller(runId: string, callerNodeId: string): void {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }
    for (const [callId, call] of state.activeCalls) {
      if (call.owner !== callerNodeId || !call.parked) {
        continue;
      }
      this.failParked(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: the calling agent ended before answering',
        'orphaned',
      );
    }
  }

  /**
   * Unpark-and-fail, exactly once: clear the parked state FIRST so a
   * re-entrant deliver/expire cannot double-settle, stamp the typed reason
   * the settled chain surfaces instead of CALLEE_CANCELLED, persist the
   * resolution row, then cancel the parked turn.
   */
  private failParked(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
    reason: string,
    outcome: 'timeout' | 'orphaned',
  ): void {
    const parked = call.parked;
    if (!parked) {
      return;
    }
    call.parked = null;
    clearTimeout(parked.timer);
    call.failReason = reason;
    state.capability.persistItem(call.owner, 'call_answer', null, {
      callId,
      callerNodeId: call.owner,
      calleeNodeId: call.calleeId,
      outcome,
    });
    parked.fail();
  }

  /**
   * Resolve with the call's FINAL envelope — or divert early with a
   * `question` envelope the moment the callee parks. `settled` is the
   * fallback for calls that already left `activeCalls`.
   */
  private waitForOutcome(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
  ): Promise<CallEnvelope> {
    const call = state.activeCalls.get(callId);
    if (!call) {
      return settled;
    }
    if (call.parked) {
      return Promise.resolve(questionEnvelope(callId, call));
    }
    return new Promise((resolve) => {
      let done = false;
      const once = (envelope: CallEnvelope): void => {
        if (!done) {
          done = true;
          resolve(envelope);
        }
      };
      call.questionWaiters.push(once);
      void call.settled.then(once);
    });
  }

  /** TTL fired: fail the parked call with the typed question_timeout error. */
  private expireQuestion(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call) {
      return;
    }
    this.failParked(
      state,
      callId,
      call,
      'QUESTION_TIMEOUT: the caller never answered the question',
      'timeout',
    );
  }

  /**
   * The caller's own chain depth: 0 for a DAG-launched node, otherwise the
   * deepest live callee turn of that node (a callee acting as a caller
   * inherits the depth of the call that spawned it; max is conservative when
   * the same node serves several concurrent calls).
   */
  private callerDepth(state: RunCallState, callerNodeId: string): number {
    let depth = 0;
    for (const call of state.activeCalls.values()) {
      if (call.calleeId === callerNodeId && call.depth > depth) {
        depth = call.depth;
      }
    }
    return depth;
  }
}

/** Resolve a callee by node id first, then by display name (trimmed). */
function resolveCallee(
  callees: readonly WorkflowAgentNode[],
  ref: string,
): WorkflowAgentNode | null {
  const wanted = ref.trim();
  const byId = callees.find((c) => c.id === wanted);
  if (byId) {
    return byId;
  }
  const byName = callees.filter((c) => c.name === wanted);
  // An ambiguous display name must not silently pick a callee.
  return byName.length === 1 ? byName[0]! : null;
}

function questionEnvelope(callId: string, call: ActiveCall): CallEnvelope {
  return {
    status: 'question',
    call_id: callId,
    agent: call.calleeId,
    question: call.parked?.question ?? '',
    options: call.parked?.options ?? [],
  };
}

function toEnvelope(
  callId: string,
  calleeId: string,
  outcome: CalleeTurnOutcome,
): CallEnvelope {
  if (outcome.status === 'completed') {
    return {
      status: 'ok',
      result: {
        call_id: callId,
        agent: calleeId,
        text: outcome.finalText ?? '',
      },
    };
  }
  if (outcome.status === 'cancelled') {
    return {
      status: 'error',
      error: 'CALLEE_CANCELLED: the callee turn was cancelled',
    };
  }
  return {
    status: 'error',
    error: `CALLEE_FAILED: ${outcome.error ?? 'the callee turn failed'}`,
  };
}
