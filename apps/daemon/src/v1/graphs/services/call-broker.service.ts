import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';

import { AgentEventBus } from '../../agents/services/agent-events.bus';
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

/**
 * How long a call may go with the callee producing NOTHING before the caller's
 * transcript says so.
 *
 * Bounded by SILENCE rather than by total duration, mirroring
 * `agents/utils/spawn-cli.ts`'s `TURN_SILENCE_DEADLINE_MS`: an agent turn
 * legitimately runs for many minutes, so a duration cap would abort real work,
 * while a callee that has emitted nothing at all for this long has either
 * wedged or is waiting on something nobody can see.
 *
 * It SURFACES and never settles the call — the wait continues untouched.
 * `callAgent` takes no cancellation signal, and adding one would change what
 * `sync` MEANS. What was missing was never the ability to stop a call; it was
 * any way to tell that one had stopped producing.
 *
 * It is SUSPENDED while the callee is blocked on an approval card
 * ({@link ActiveCall.blockedOnVerdicts}), the same carve-out `spawn-cli.ts`
 * makes: a callee waiting on a person emits nothing by construction, so
 * without it the window would time the human and report a callee that is
 * doing exactly what it should.
 */
const CALL_SILENCE_DEADLINE_MS = 10 * 60_000;

/**
 * A collection whose REQUEST went away before the callee settled.
 *
 * A sentinel rather than an error envelope, because the difference has to
 * survive the return: an envelope would be indistinguishable from an outcome
 * the caller is owed, and it is precisely the "nobody is there to receive
 * this" reading that must stop the entry being consumed.
 */
const ABANDONED = Symbol('await-abandoned');

/**
 * A collection whose own `timeout_ms` elapsed with the callee still working.
 *
 * A sentinel for {@link ABANDONED}'s reason — the difference between "still
 * running" and an outcome must survive the return, and it is what stops the
 * entry being consumed. The two are kept APART rather than folded into one
 * "did not collect" because they mean opposite things to the caller: an
 * abandonment says nobody was there to receive the answer, while this says the
 * caller deliberately stopped waiting and means to come back.
 */
const TIMED_OUT = Symbol('await-timed-out');

interface AsyncCallEntry {
  /** The caller that started the call — only it may collect the result. */
  owner: string;
  /**
   * The callee this call went to, so a {@link TIMED_OUT} collection can NAME it
   * without reaching into `activeCalls` — which a settled-but-uncollected call
   * has already left, and where a lookup would therefore have to fall back to a
   * blank agent on exactly the arm whose whole content is "who is still busy".
   */
  calleeId: string;
  settled: Promise<CallEnvelope>;
  /**
   * Whether the caller has been WOKEN to collect this result — once per call,
   * for the reason {@link ParkedQuestion.ownerTold} is once per question.
   */
  told: boolean;
}

/** A parked mid-turn question — the callee is blocked on answer_agent. */
interface ParkedQuestion {
  question: string;
  options: string[];
  timer: NodeJS.Timeout;
  /**
   * The window this question was parked with, kept so a re-arm uses the SAME
   * one — the executor's capture seam may name its own, and re-arming with the
   * module constant instead would silently give a test-scale TTL a
   * five-minute one.
   */
  ttlMs: number;
  deliver(answer: string): boolean;
  fail(): void;
  /**
   * Whether the caller has already been WOKEN with this question. A caller
   * that ends again without answering is not woken a second time — which is
   * what keeps one that keeps ending its turn from looping on one question.
   */
  ownerTold: boolean;
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
  /**
   * The silence watchdog — re-armed by every row the callee produces, cleared
   * when the call settles. See {@link CALL_SILENCE_DEADLINE_MS}.
   */
  silence: NodeJS.Timeout | null;
  /**
   * Whether the transcript has ALREADY been told this call went quiet.
   *
   * One row per call, not one per silent stretch: the watchdog re-arms on the
   * callee's next row, and a call that goes quiet repeatedly would otherwise
   * write an advisory every ten minutes into the conversation it is warning
   * about.
   */
  saidStalled: boolean;
  /**
   * How many verdicts this callee is blocked on — approval cards raised for it
   * and not yet answered.
   *
   * The silence watchdog is SUSPENDED while this is non-zero, mirroring
   * `spawn-cli.ts`'s own deadline, which stands down while a turn has
   * outstanding requests. A callee parked on a card emits nothing by
   * construction, so timing it would be timing the person looking at the card
   * — and "has produced nothing" is then true and useless.
   *
   * A COUNT rather than a flag: a turn can have several cards open at once,
   * and the wait is over only when the last of them is answered.
   */
  blockedOnVerdicts: number;
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

/** A question a woken caller is being told about. */
interface WakeQuestion {
  callId: string;
  /** The callee, by the name the caller knows it by. */
  callee: string;
  question: string;
  options: readonly string[];
}

/** A result a woken caller is being told to collect. */
interface WakeResult {
  callId: string;
  callee: string;
}

/**
 * The message a woken caller receives. Written to the AGENT, since it opens a
 * turn of that agent's own conversation, and naming the exact tool call that
 * settles each item so nothing about what to do next has to be inferred.
 */
function wakePrompt(
  asked: readonly WakeQuestion[],
  finished: readonly WakeResult[],
): string {
  const lines = [
    '[geniro] Your previous turn ended with calls of yours still open:',
  ];
  for (const item of asked) {
    const options =
      item.options.length > 0 ? ` (options: ${item.options.join(' / ')})` : '';
    lines.push(
      '',
      `- ${item.callee} is blocked on a question in ${item.callId}: "${item.question}"${options}`,
      `  Answer it with answer_agent(call_id: "${item.callId}", answer: ...) — or, if it is the user's decision rather than yours, ask the user first — then collect the result with await_agent(call_id: "${item.callId}").`,
    );
  }
  for (const item of finished) {
    lines.push(
      '',
      `- ${item.callee} has finished ${item.callId}. Collect its result with await_agent(call_id: "${item.callId}") and carry on from there.`,
    );
  }
  return lines.join('\n');
}

/** The transcript's account of a wake, filed under the caller that was woken. */
function wakeNotice(
  asked: readonly WakeQuestion[],
  finished: readonly WakeResult[],
): string {
  const reasons = [
    ...asked.map((item) => `${item.callee} asked a question in ${item.callId}`),
    ...finished.map((item) => `${item.callee} finished ${item.callId}`),
  ];
  return `Started another turn for this agent: ${reasons.join('; ')} after its turn had ended.`;
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
export class CallBroker implements OnModuleInit {
  private readonly runs = new Map<string, RunCallState>();

  /**
   * `@Optional()` on the bus, exactly as `AgentEventBus` itself takes its
   * registry: a dozen specs build a bare `new CallBroker()` to drive call
   * semantics, and none of them is about run deletion. Without one the
   * subscription below simply never happens — which is the pre-existing
   * behaviour rather than a degraded one.
   */
  constructor(@Optional() private readonly bus?: AgentEventBus) {}

  /**
   * Drop a run's call state when the run itself is DESTROYED.
   *
   * The executor already unregisters on its own delete, so this is the second
   * belt — and the one that covers a purge it never sees. The retention sweep
   * destroys an archived run through `ChatService`, which sits in the module
   * BELOW this one and cannot call into it; announcing the deletion downward is
   * the inversion `AgentEventBus.publishRunDeleted` exists for, and it says so
   * at its own definition. Without this, a swept workflow run left its capability,
   * its uncollected async results and any parked question's timer behind for the
   * life of the daemon.
   *
   * Idempotent, which is what makes two callers safe: `unregisterRun` on a run
   * it has never heard of clears nothing and throws nothing.
   */
  onModuleInit(): void {
    this.bus?.allDeleted().subscribe((runId) => {
      this.unregisterRun(runId);
    });
  }

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
      // No timer of a call open at teardown may fire into a dead run (the
      // executor already cancelled every callee handle on the way here). BOTH
      // kinds: the parked question's TTL, and the silence watchdog — a wedged
      // callee is exactly what arms the second one AND what makes the delete's
      // own settle wait time out, so it is the likeliest to still be here.
      for (const call of state.activeCalls.values()) {
        if (call.parked) {
          clearTimeout(call.parked.timer);
          call.parked = null;
        }
        if (call.silence !== null) {
          clearTimeout(call.silence);
          call.silence = null;
        }
      }
      state.activeCalls.clear();
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
      silence: null,
      saidStalled: false,
      blockedOnVerdicts: 0,
    };
    state.activeCalls.set(callId, call);
    this.armSilenceWatch(runId, callId, call);
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
        // Same rule for the silence watchdog, and the same reason: a settled
        // call must not later announce that it went quiet.
        if (call.silence !== null) {
          clearTimeout(call.silence);
          call.silence = null;
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
        calleeId: callee.id,
        settled: call.settled,
        told: false,
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
    args: {
      call_id: string;
      /**
       * How long to block before answering `pending` instead — absent means
       * block until the callee settles, which is what every caller got before
       * this existed.
       *
       * Taken as given: the BOUNDS are the MCP layer's, where a model's
       * arguments are validated and an out-of-range one becomes INVALID_ARGS.
       * Here it is a plain number, so a spec can name a millisecond window and
       * drive the whole path in no wall-clock time.
       */
      timeout_ms?: number;
    },
    /**
     * Trips when the HTTP request this collection is answering has gone away —
     * see {@link ABANDONED}. Absent = a caller that cannot be abandoned (a
     * test, an in-process caller).
     */
    signal?: AbortSignal,
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
    const envelope = await this.untilAbandoned(
      signal,
      this.untilDeadline(
        args.timeout_ms,
        this.waitForOutcome(state, args.call_id, entry.settled),
      ),
    );
    // The request is GONE — its socket closed while this collection was
    // blocked. Consuming here is what cost a caller a whole callee turn: the
    // entry is deleted, `await_collected` is written, and the envelope is
    // handed to a reply nobody will read, so the retry is told UNKNOWN_CALL
    // and the work is unreachable for the rest of the run.
    if (envelope === ABANDONED) {
      return {
        status: 'error',
        error: `AWAIT_ABANDONED: the request collecting '${args.call_id}' ended before the callee did — the result is still collectable`,
      };
    }
    // The caller asked to stop waiting, so it is told exactly that and NOTHING
    // is consumed: the entry stays, no `await_collected` row is written, and
    // the next await picks up where this one left off. Identical mechanics to
    // the abandonment above — the two differ only in what the caller is told,
    // because only one of them was the caller's own decision.
    if (envelope === TIMED_OUT) {
      return {
        status: 'pending',
        call_id: args.call_id,
        agent: entry.calleeId,
      };
    }
    if (envelope.status === 'question') {
      // The TTL counts from the moment the caller can actually SEE the
      // question, not from the park. A question raised into a collection that
      // had already been abandoned reached nobody, and the clock was then
      // timing a caller that was never told — which is the whole of
      // "QUESTION_TIMEOUT: the caller never answered the question" on a run
      // whose caller had asked and been cut off. This is the one delivery that
      // is observed rather than assumed.
      this.rearmQuestionTtl(runId, args.call_id);
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
    const ttlMs = input.ttlMs ?? QUESTION_TTL_MS;
    const timer = setTimeout(() => this.expireQuestion(runId, callId), ttlMs);
    timer.unref?.();
    call.parked = {
      question: input.question,
      options: input.options,
      timer,
      ttlMs,
      deliver: input.deliver,
      fail: input.fail,
      ownerTold: false,
    };
    state.capability.persistItem(call.owner, 'call_question', null, {
      callId,
      callerNodeId: call.owner,
      calleeNodeId: call.calleeId,
      question: input.question,
      options: input.options,
      payload: input.payload,
    });
    // A fire-and-forget caller never sees envelopes, so nobody can ever
    // answer_agent this question: orphan NOW instead of grinding through the
    // TTL with the run held open (the question row above still shows what was
    // asked).
    if (call.mode === 'fire_and_forget') {
      this.orphan(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
      );
      return true;
    }
    // A sync call that parks becomes await_agent-collectable — its caller got
    // the question envelope in place of the final result.
    if (!state.pendingAsync.has(callId)) {
      state.pendingAsync.set(callId, {
        owner: call.owner,
        calleeId: call.calleeId,
        settled: call.settled,
        told: false,
      });
    }
    // A caller whose turns have all ENDED is woken with the question rather
    // than having its callee killed under it. Orphaning here is what made a
    // workflow "stop in the middle without any error": a Manager said "I'll
    // report back" and ended its turn, its Engineer then asked something, and
    // the Engineer was cancelled while the run closed as completed. It is
    // orphaned only when there is no turn left to give the caller.
    if (
      !state.capability.isNodeLive(call.owner) &&
      !this.wakeOwner(runId, state, call.owner, [callId], [])
    ) {
      this.orphan(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
      );
      return true;
    }
    const envelope = questionEnvelope(callId, call);
    for (const notify of call.questionWaiters.splice(0)) {
      notify(envelope);
    }
    return true;
  }

  /**
   * A caller node's LAST live turn has settled (the executor calls this next
   * to its approval sweep): wake it ONCE with whatever it left open — the
   * questions its callees are blocked on, and the async results nothing has
   * collected — so the conversation it started can finish.
   *
   * It used to fail the questions outright as QUESTION_ORPHANED, on the
   * reasoning that a settled caller can never answer_agent. It can now: a wake
   * is another turn of that caller's own conversation. A question it was
   * ALREADY woken for, and ended again without answering, is orphaned as
   * before — with a row that says so — which bounds this to one wake apiece.
   */
  drainCaller(runId: string, callerNodeId: string): void {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }
    const questions: string[] = [];
    for (const [callId, call] of state.activeCalls) {
      if (call.owner !== callerNodeId || !call.parked) {
        continue;
      }
      if (call.parked.ownerTold) {
        this.orphan(
          state,
          callId,
          call,
          'QUESTION_ORPHANED: the calling agent ended before answering',
        );
        continue;
      }
      questions.push(callId);
    }
    // A result is WAITING once its call has settled — one still running is
    // reported by `noteCalleeSettling` when it lands instead.
    const results = [...state.pendingAsync]
      .filter(
        ([callId, entry]) =>
          entry.owner === callerNodeId &&
          !entry.told &&
          !state.activeCalls.has(callId),
      )
      .map(([callId]) => callId);
    if (questions.length === 0 && results.length === 0) {
      return;
    }
    if (this.wakeOwner(runId, state, callerNodeId, questions, results)) {
      return;
    }
    for (const callId of questions) {
      const call = state.activeCalls.get(callId);
      if (call) {
        this.orphan(
          state,
          callId,
          call,
          'QUESTION_ORPHANED: the calling agent ended before answering',
        );
      }
    }
  }

  /**
   * A callee's turn is settling. If its result is owed to a caller whose turns
   * have all ENDED — an async call, or a sync one that parked and so became
   * collectable — wake that caller to collect it.
   *
   * The half `drainCaller` cannot cover: that runs when the CALLER ends, and a
   * callee still working at that moment has no result to report yet. A Manager
   * that launches an Engineer, says "I'll report back" and ends its turn is
   * exactly this case — without it the Engineer's work lands in a result
   * nothing ever collects, and the run closes as though the work were done.
   *
   * Called by the executor from the callee's own settle bookkeeping, BEFORE the
   * turn stops holding the run open, so the wake is counted before the run can
   * decide it has finished.
   */
  noteCalleeSettling(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    const entry = state?.pendingAsync.get(callId);
    if (!state || !call || !entry || entry.told) {
      return;
    }
    // A live caller collects it itself; one that then ends without doing so
    // is told by `drainCaller`.
    if (state.capability.isNodeLive(call.owner)) {
      return;
    }
    this.wakeOwner(runId, state, call.owner, [], [callId]);
  }

  /**
   * Start another turn for `owner` carrying what it left open, marking each
   * item told so it is never woken for twice, and saying in its transcript why
   * it is talking again. False when the run cannot take a turn (cancelled,
   * finished) — the caller then falls back to what it did before wakes existed.
   */
  private wakeOwner(
    runId: string,
    state: RunCallState,
    owner: string,
    questions: readonly string[],
    results: readonly string[],
  ): boolean {
    const asked = questions.flatMap((callId): WakeQuestion[] => {
      const call = state.activeCalls.get(callId);
      return call?.parked
        ? [
            {
              callId,
              callee: this.calleeName(state, owner, call.calleeId),
              question: call.parked.question,
              options: call.parked.options,
            },
          ]
        : [];
    });
    const finished = results.flatMap((callId): WakeResult[] => {
      const entry = state.pendingAsync.get(callId);
      return entry
        ? [{ callId, callee: this.calleeName(state, owner, entry.calleeId) }]
        : [];
    });
    if (asked.length === 0 && finished.length === 0) {
      return false;
    }
    if (!state.capability.wakeNode(owner, wakePrompt(asked, finished))) {
      return false;
    }
    for (const item of asked) {
      const parked = state.activeCalls.get(item.callId)?.parked;
      if (parked) {
        parked.ownerTold = true;
      }
      // Its window counts from the moment the caller is TOLD, as it does for
      // a question first seen through await_agent.
      this.rearmQuestionTtl(runId, item.callId);
    }
    for (const item of finished) {
      const entry = state.pendingAsync.get(item.callId);
      if (entry) {
        entry.told = true;
      }
    }
    state.capability.persistItem(owner, 'system', null, {
      severity: 'info',
      message: wakeNotice(asked, finished),
    });
    return true;
  }

  /**
   * Orphan a parked question — and say so in the caller's transcript, since a
   * callee cancelled under its own question is otherwise a stop with no error
   * anywhere. The result is marked told as well: the caller has had its
   * chance, and a turn spent only to report this orphaning back would be noise.
   */
  private orphan(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
    reason: string,
  ): void {
    const entry = state.pendingAsync.get(callId);
    if (entry) {
      entry.told = true;
    }
    state.capability.persistItem(call.owner, 'system', null, {
      message: `${this.calleeName(state, call.owner, call.calleeId)} was stopped: it asked a question in ${callId} and no turn of this agent was left to answer it.`,
    });
    this.failParked(state, callId, call, reason, 'orphaned');
  }

  /** A callee by the name its caller knows it by, else its node id. */
  private calleeName(
    state: RunCallState,
    owner: string,
    calleeId: string,
  ): string {
    return (
      state.capability.calleesOf
        .get(owner)
        ?.find((node) => node.id === calleeId)?.name ?? calleeId
    );
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

  /**
   * The callee produced a row — it is demonstrably alive, so restart its
   * silence watchdog.
   *
   * Called from the executor's own callee persist seam, which is the only
   * place that sees a callee's output: the broker launches the turn and then
   * holds a promise, so without this hook its only measurable quantity is
   * total duration — the bound {@link CALL_SILENCE_DEADLINE_MS} exists not to
   * use.
   *
   * A no-op for a call that is settled or unknown, so a row arriving after the
   * result cannot re-arm a clock on a call that is over.
   */
  noteCalleeActivity(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (call) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * An approval card went up for this callee — SUSPEND its silence watchdog
   * until the card is answered.
   *
   * A callee blocked on a verdict emits nothing by construction, so a window
   * that kept running would be timing the person reading the card, and would
   * report "has produced nothing" about a callee doing exactly what it should.
   * `spawn-cli.ts` stands its own silence deadline down for the same reason and
   * on the same reasoning.
   *
   * Called by the executor, which is where a callee's card is raised and where
   * its verdict lands — so no cross-module read is needed to know either.
   */
  noteCalleeBlocked(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.blockedOnVerdicts += 1;
    if (call.silence !== null) {
      clearTimeout(call.silence);
      call.silence = null;
    }
  }

  /**
   * A card this callee was blocked on has been answered (or has gone away) —
   * restart the window once the LAST of them is settled.
   *
   * Floors at zero rather than trusting the pairing: the card is gone on every
   * `respond`, delivered or not, and a settle can sweep one that was never
   * answered at all, so an unmatched call here must not drive the count
   * negative and suspend the watchdog for the rest of the call.
   */
  noteCalleeUnblocked(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.blockedOnVerdicts = Math.max(0, call.blockedOnVerdicts - 1);
    if (call.blockedOnVerdicts === 0) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * (Re)arm one call's silence watchdog. Clearing first is what makes this
   * idempotent under the callee's every row.
   */
  private armSilenceWatch(
    runId: string,
    callId: string,
    call: ActiveCall,
  ): void {
    if (call.silence !== null) {
      clearTimeout(call.silence);
      call.silence = null;
    }
    // A blocked callee stays suspended however many rows arrive: an approval
    // card is itself persisted as a row, so without this the very event that
    // suspends the window would immediately re-arm it.
    if (call.blockedOnVerdicts > 0) {
      return;
    }
    call.silence = setTimeout(() => {
      call.silence = null;
      this.announceStall(runId, callId, call);
    }, CALL_SILENCE_DEADLINE_MS);
    // Node keeps the process alive for a pending timer, and a ten-minute one
    // on every open call would hold a daemon that is otherwise done.
    call.silence.unref?.();
  }

  /**
   * Say ONCE, in the caller's own transcript, that its callee has stopped
   * producing — and do nothing else.
   *
   * Not a cancellation: the wait is untouched and the call may still settle
   * normally, which is what keeps `sync` meaning what it meant. A stalled call
   * that recovers simply produces a row, which re-arms the watchdog.
   *
   * The run is re-read from `this.runs` rather than closed over, exactly as
   * {@link expireQuestion} does and for the same reason: a captured state
   * object survives `unregisterRun`, and its `activeCalls` map still holds this
   * id — so the guard would pass and the write would insert an item for a run
   * whose rows the teardown has already purged. `Item.runId` has no foreign
   * key, so such an insert SUCCEEDS and leaves transcript text no route can
   * reach or delete.
   *
   * TWIN PARSER: this payload is read by
   * `apps/ui/src/renderer/chats/transcript-groups.ts` — `CallBlockEntry.stalled`
   * folds it by `stalledCall` + `callId`, and a later callee row for the same
   * call supersedes it. The SENTENCE is rendered by that file's `system` arm in
   * `transcript-item.tsx`, which reads the `message` key and draws nothing when
   * it is absent — so this row's wording lives under `message`, never `text`,
   * and carries `severity: 'info'` because an absent severity resolves to the
   * red failure chrome, which this row is not.
   */
  private announceStall(runId: string, callId: string, call: ActiveCall): void {
    const state = this.runs.get(runId);
    if (call.saidStalled || !state?.activeCalls.has(callId)) {
      return;
    }
    call.saidStalled = true;
    const minutes = Math.round(CALL_SILENCE_DEADLINE_MS / 60_000);
    state.capability.persistItem(call.owner, 'system', null, {
      callId,
      callerNodeId: call.owner,
      calleeNodeId: call.calleeId,
      stalledCall: true,
      severity: 'info',
      message: `'${call.calleeId}' has produced nothing for ${minutes} minutes. The call is still open — nothing has been cancelled.`,
    });
  }

  /**
   * Restart a parked question's TTL, because the caller has only NOW been
   * handed it.
   *
   * A no-op for a call that is no longer parked (answered, failed, gone), so a
   * late collection cannot resurrect a clock on a question that is over.
   */
  private rearmQuestionTtl(runId: string, callId: string): void {
    const parked = this.runs.get(runId)?.activeCalls.get(callId)?.parked;
    if (!parked) {
      return;
    }
    clearTimeout(parked.timer);
    parked.timer = setTimeout(
      () => this.expireQuestion(runId, callId),
      parked.ttlMs,
    );
    parked.timer.unref?.();
  }

  /**
   * Resolve with `promise`, or with {@link ABANDONED} the moment `signal`
   * trips — whichever happens first. A rejection from `promise` REJECTS the
   * returned promise too (never left pending) — `awaitAgent`'s caller needs
   * that to reach the MCP dispatcher's ordinary error mapping instead of
   * hanging forever.
   *
   * The point is the CALLER's side of the race rather than the callee's:
   * nothing here cancels the callee, which goes on working and settles into
   * its own entry exactly as before. All this decides is whether the
   * collection that was waiting is still there to be given the answer.
   */
  private untilAbandoned<TOutcome>(
    signal: AbortSignal | undefined,
    promise: Promise<TOutcome>,
  ): Promise<TOutcome | typeof ABANDONED> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.resolve(ABANDONED);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => resolve(ABANDONED);
      signal.addEventListener('abort', onAbort, { once: true });
      // Both arms must remove the listener before settling — a rejection
      // left it attached, which is otherwise harmless (the promise is
      // already settled) but keeps the signal referencing this closure.
      void promise.then(
        (envelope) => {
          signal.removeEventListener('abort', onAbort);
          resolve(envelope);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Resolve with `promise`, or with {@link TIMED_OUT} after `timeoutMs` —
   * whichever happens first. No window means no race at all, which is the
   * unbounded wait every caller had before. A rejection from `promise`
   * REJECTS the returned promise too, on the same terms as
   * {@link untilAbandoned}.
   *
   * Nothing here touches the callee, exactly as {@link untilAbandoned} does
   * not: this decides only how long THIS collection stands there. It nests
   * INSIDE the abandonment race rather than beside it because the two answers
   * are not peers — a socket that closed means the answer cannot be delivered
   * at all, which outranks the caller having wanted a shorter wait, and a
   * flat three-way race would let a deadline that fired in the same tick
   * report `pending` into a reply nobody will read.
   */
  private untilDeadline<TOutcome>(
    timeoutMs: number | undefined,
    promise: Promise<TOutcome>,
  ): Promise<TOutcome | typeof TIMED_OUT> {
    if (timeoutMs === undefined) {
      return promise;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      // A deadline is a convenience for the caller, never a reason to keep the
      // daemon alive — the callee's own turn is what holds the run open.
      timer.unref?.();
      void promise.then(
        (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
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
