import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';

import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type {
  CalleeTurnOutcome,
  CallEnvelope,
  CallMode,
  ParkQuestionInput,
  RunCallCapability,
  RunCallSeed,
  WorkflowAgentNode,
} from '../graphs.types';
import { callNumber } from '../utils/call-seed';

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
 * It SURFACES and never settles the call — the wait continues untouched. A
 * sync call has no deadline; the one abandonment it notices is its HTTP
 * request going away, which ends only the reply and never cancels the callee. What was missing was never the ability to stop a call; it was
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

/** Lets a wait that gave up (timed out, abandoned) stop listening for questions. */
interface WaitLease {
  release: () => void;
}

/** A parked mid-turn question — the callee is blocked on answer_agent. */
interface ParkedQuestion {
  question: string;
  options: string[];
  /**
   * The TTL clock — or null while it is SUSPENDED because the caller that
   * has to answer is itself blocked on a card of its own
   * ({@link RunCallState.blockedOwners}). A caller inside its own
   * AskUserQuestion cannot call answer_agent, so a window that kept running
   * timed the person reading the caller's card and failed the callee for it:
   * measured on a real run, both QUESTION_TIMEOUTs fired inside the Manager's
   * own question to the user (answered after 33 minutes, and after 12 hours).
   * Re-armed, with its full window, the moment that card is answered.
   */
  timer: NodeJS.Timeout | null;
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
  /**
   * Whether a `question` envelope for it has been RETURNED to the caller — by
   * the wait it diverted, or by a wait that started after it parked. Once is
   * enough: a caller that reads the question and waits again is choosing to,
   * and handing it back on every await would keep that wait from ever starting.
   */
  envelopeDelivered: boolean;
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
  /**
   * Sync/await waiters diverted early when a question parks mid-wait. Each
   * answers whether it was still waiting — a settled wait leaves its entry
   * behind, and a delivery to it reaches nobody.
   */
  questionWaiters: ((envelope: CallEnvelope) => boolean)[];
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
  /**
   * The tool calls this callee has started and not yet had answered, by id.
   *
   * The silence watchdog is SUSPENDED while any is open: a callee waiting on
   * its own tool is working, however long the tool takes and whether or not it
   * writes anything meanwhile. REPORTED as "'qa' has produced nothing for 10
   * minutes" over a QA agent that had launched ten reviewer sub-agents as
   * `Task` tool calls — their results arrived at 16:39 and 16:50, and a cursor
   * delegate puts nothing on the wire in between. A SET rather than a count, so
   * a tool call announced twice is one open call.
   */
  openToolCalls: Set<string>;
  /**
   * The conversation this call runs in — see {@link ThreadRecord.conversationId}.
   * What a thread continuation is checked against: one conversation serves one
   * call at a time.
   */
  conversationId: string;
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
  /**
   * The FIRST call of this conversation — the id every continuation of it
   * is keyed by, however many calls deep it is.
   *
   * A continuation used to be keyed by its OWN call id, so the executor spawned
   * a fresh `--resume <session>` process for it while the previous call's
   * process was still kept alive under the previous id: two live CLI processes
   * on one session, each holding the conversation, each free to act. Measured
   * on a real run — an Engineer found two `claude -p --resume 43bb7bb7…`
   * children of the daemon editing its worktree at once, then three. Keyed by
   * the conversation, a continuation reaches the kept process (or resumes the
   * session in a fresh one only once that process is gone).
   */
  conversationId: string;
}

interface RunCallState {
  /** The run this state belongs to — what a clock re-armed from a helper names. */
  runId: string;
  capability: RunCallCapability;
  callSeq: number;
  turnsStarted: number;
  /** Live callee turns keyed by call id. */
  activeCalls: Map<string, ActiveCall>;
  /** Results retained until their caller collects them via await_agent. */
  pendingAsync: Map<string, AsyncCallEntry>;
  /** Settled calls' resume handles keyed by call id (thread continuation). */
  threads: Map<string, ThreadRecord>;
  /**
   * The highest call number an EARLIER daemon gave this run — what
   * {@link RunCallSeed} carried in. An id at or below it that no map holds is
   * a call whose result died with that daemon, and the refusal says so.
   */
  seededCallSeq: number;
  /**
   * What each node is blocked on right now, as a set of names (node id →
   * blockers) — the owner-side twin of {@link ActiveCall.blockedOnVerdicts}.
   * While a node holds any, every question ITS callees park has its TTL
   * suspended: see {@link ParkedQuestion.timer}.
   *
   * Two kinds of blocker, because a node can be stuck two ways: a CARD it
   * raised (its own question to the user, a permission in ask mode), named by
   * the executor; and a question it PARKED on its own caller, named here
   * ({@link parkBlocker}). A callee that is itself a caller — Manager →
   * Engineer → Researcher — cannot answer Researcher while it waits on Manager.
   *
   * A SET rather than a count: spawn-cli re-offers a request its turn settled
   * without an answer to the next turn of the same process, so one card can
   * arrive twice, and a count then needed two answers to that one card before
   * the node's callees' questions resumed.
   */
  blockedOwners: Map<string, Set<string>>;
  /**
   * How many waits each node currently has OPEN on its own calls (node id →
   * count) — a sync `call_agent`, an `await_agent` for one call, an
   * `await_agent` for all of them.
   *
   * A node in here is inside a tool call that cannot return until a callee it
   * started does: it is in a turn by every reading the daemon has, and it is
   * producing nothing. That is what the composer needs to know before it
   * queues a message — see {@link RunStatusEvent.awaitingCalls}, which this
   * map's SIZE is announced as.
   *
   * A COUNT per node rather than a flag, on {@link blockedOwners}' reasoning
   * one step over: a caller can hold a sync call open and start a collection
   * beside it, and the node stops waiting only when the last of them returns.
   */
  waitingOwners: Map<string, number>;
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
  whileWorking = false,
): string {
  const lines = [
    whileWorking
      ? '[geniro] A call of yours needs you while you work:'
      : '[geniro] Your previous turn ended with calls of yours still open:',
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

  /**
   * The executor announces a run whose workflow carries call edges.
   *
   * `seed` is what an earlier pass of this run left in the transcript — see
   * {@link RunCallSeed}. Call ids continue past it, and every settled call it
   * names is a thread again, so a conversation built before a daemon restart
   * can be continued after it. A continuation's conversation is rebuilt
   * through the parent chain, in transcript order, so two points of one old
   * conversation still share a key rather than each resuming the session in a
   * process of its own.
   */
  registerRun(
    runId: string,
    capability: RunCallCapability,
    seed: RunCallSeed | null = null,
  ): void {
    const threads = new Map<string, ThreadRecord>();
    for (const record of seed?.records ?? []) {
      threads.set(record.callId, {
        owner: record.callerNodeId,
        calleeId: record.calleeNodeId,
        sessionId: record.sessionId,
        conversationId:
          (record.thread === null
            ? null
            : threads.get(record.thread)?.conversationId) ?? record.callId,
      });
    }
    this.runs.set(runId, {
      runId,
      capability,
      callSeq: seed?.callSeq ?? 0,
      seededCallSeq: seed?.callSeq ?? 0,
      turnsStarted: 0,
      activeCalls: new Map(),
      pendingAsync: new Map(),
      threads,
      blockedOwners: new Map(),
      waitingOwners: new Map(),
    });
  }

  /**
   * How many of a run's agents are sitting inside a wait on their own calls —
   * what {@link runToWire} puts on the run's snapshot.
   *
   * 0 for a run this broker has never heard of, which is every chat: a chat has
   * no call runtime, so nothing in one can be waiting.
   */
  awaitingCalls(runId: string): number {
    return this.runs.get(runId)?.waitingOwners.size ?? 0;
  }

  /**
   * One node has entered a wait on its own calls; announce if it is the first.
   *
   * The announce is per RUN and carries the number of waiting NODES, so a
   * caller opening a second wait beside its first says nothing new — the fact
   * the composer reads ("is anything in this run merely waiting") has not
   * changed, and re-announcing it would be a socket emission per await.
   */
  private beginOwnerWait(state: RunCallState, owner: string): void {
    const open = state.waitingOwners.get(owner) ?? 0;
    state.waitingOwners.set(owner, open + 1);
    if (open === 0) {
      this.announceWaiting(state);
    }
  }

  /**
   * One node's wait has returned — by a result, a question, a timeout or an
   * abandonment, all of which end the tool call it was parked in.
   *
   * Every call site pairs this with {@link beginOwnerWait} in a `finally`: a
   * wait that threw its way out would otherwise leave the node counted as
   * waiting for the life of the run, and the composer would go on sending
   * messages straight into turns that really are working.
   */
  private endOwnerWait(state: RunCallState, owner: string): void {
    const open = state.waitingOwners.get(owner) ?? 0;
    if (open <= 1) {
      state.waitingOwners.delete(owner);
      this.announceWaiting(state);
      return;
    }
    state.waitingOwners.set(owner, open - 1);
  }

  /**
   * Run one wait with its owner counted as waiting for exactly its duration.
   *
   * A helper rather than a begin/finally pair at each of the three wait sites,
   * because the pairing is the whole invariant: a site that begins and does not
   * end leaves the node counted as waiting for the life of the run.
   */
  private async whileWaiting<T>(
    state: RunCallState,
    owner: string,
    wait: () => Promise<T>,
  ): Promise<T> {
    this.beginOwnerWait(state, owner);
    try {
      return await wait();
    } finally {
      this.endOwnerWait(state, owner);
    }
  }

  private announceWaiting(state: RunCallState): void {
    this.bus?.publishRunStatus({
      runId: state.runId,
      status: null,
      awaitingCalls: state.waitingOwners.size,
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
          stopQuestionTimer(call.parked);
          call.parked = null;
        }
        if (call.silence !== null) {
          clearTimeout(call.silence);
          call.silence = null;
        }
      }
      state.activeCalls.clear();
      // A run being torn down is waiting on nothing. The waits themselves end
      // on their own (their calls are cancelled), but the ANNOUNCE they would
      // make goes to a run this map no longer holds — so it is made here, while
      // the state is still reachable, and the composer is not left believing a
      // destroyed run's agents are parked.
      if (state.waitingOwners.size > 0) {
        state.waitingOwners.clear();
        this.announceWaiting(state);
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
    args: {
      agent: string;
      message: string;
      mode?: CallMode;
      thread?: string;
      /**
       * A short, human-readable reason for this call, shown on its transcript
       * card and carried onto the `call_started` item. Validated and trimmed
       * by `validateCallAgentArgs` in `mcp-server.service.ts`.
       */
      title: string;
    },
    /**
     * Trips when the HTTP request this sync call is answering has gone away —
     * a client that cuts long tool calls off. Absent = cannot be abandoned.
     */
    signal?: AbortSignal,
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
    let conversationId: string | null = null;
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
      // One conversation serves one call at a time. A second continuation
      // while the first still runs would either resume the session in a
      // second process (the fork this keying exists to end) or, keyed
      // together, have the registry replace the running process — killing the
      // first call mid-work. Refusing is the only reading under which the
      // conversation stays one conversation; the caller awaits and continues
      // from the call that is running.
      for (const [liveId, live] of state.activeCalls) {
        if (live.conversationId === thread.conversationId) {
          return {
            status: 'error',
            error: `THREAD_BUSY: '${liveId}' is still running on that conversation — continue with thread: '${liveId}' once it has finished (await_agent collects it if you started it async)`,
          };
        }
      }
      resumeSessionId = thread.sessionId;
      conversationId = thread.conversationId;
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
      openToolCalls: new Set(),
      // A fresh call opens a conversation of its own, named after itself.
      conversationId: conversationId ?? callId,
    };
    state.activeCalls.set(callId, call);
    this.armSilenceWatch(runId, callId, call);
    // TWIN PARSER: apps/ui/src/renderer/chats/transcript-groups.ts reads this
    // payload — `buildCallBlock` (`title` onto `CallBlockEntry.title`) and
    // `resolveCallChains` (`thread`, which folds a continued conversation into
    // one card); a renamed or reshaped key is mirrored there.
    state.capability.persistItem(callerNodeId, 'call_started', null, {
      callId,
      callerNodeId,
      calleeNodeId: callee.id,
      mode,
      message: args.message,
      ...(args.thread !== undefined ? { thread: args.thread } : {}),
      title: args.title,
    });

    // The settled turn's CLI session id, mirrored into the call_result item so
    // the UI can open a terminal on (or reason about) that specific thread.
    let threadSessionId: string | null = null;
    call.settled = state.capability
      .launchCalleeTurn(
        callee,
        args.message,
        callId,
        depth,
        resumeSessionId,
        call.conversationId,
      )
      .then((outcome) => {
        // Every settled turn leaves a resume handle so the conversation can
        // be continued from THIS point with `thread: <this call_id>`.
        state.threads.set(callId, {
          owner: callerNodeId,
          calleeId: callee.id,
          sessionId: outcome.sessionId,
          conversationId: call.conversationId,
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
        // The turn died with a question still parked (external cancel,
        // crash) — the timer must not fire into a settled call, and the
        // callee must not stay counted as blocked on it.
        this.unpark(state, callId, call);
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
      const lease: WaitLease = { release: () => {} };
      const outcome = signal?.aborted
        ? ABANDONED
        : await this.whileWaiting(state, callerNodeId, () =>
            this.untilAbandoned(
              signal,
              this.waitForOutcome(state, callId, call.settled, lease),
            ),
          );
      if (outcome === ABANDONED) {
        // Nobody is reading this reply, so the waiter must not keep accepting
        // questions — and the result must stay reachable for a retry.
        lease.release();
        makeCollectable(state, callId, call);
        return {
          status: 'error',
          error: `AWAIT_ABANDONED: the request for '${callId}' ended before the callee did — collect it with await_agent`,
        };
      }
      if (outcome.status === 'question') {
        this.rearmQuestionTtl(runId, outcome.call_id);
      }
      return outcome;
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
      /**
       * The call to collect. Absent = wait on ALL of the caller's open calls
       * and return the FIRST thing any of them produces — see `awaitAny`.
       */
      call_id?: string;
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
    if (args.call_id === undefined) {
      return this.awaitAny(runId, state, callerNodeId, args.timeout_ms, signal);
    }
    const callId = args.call_id;
    const entry = state.pendingAsync.get(callId);
    if (!entry || entry.owner !== callerNodeId) {
      return this.unknownCall(state, callId, 'un-collected async call');
    }
    const lease: WaitLease = { release: () => {} };
    // A request already gone must not reach `waitForOutcome`, which would hand
    // it — and mark delivered — a question nobody will read.
    const envelope = signal?.aborted
      ? ABANDONED
      : await this.whileWaiting(state, callerNodeId, () =>
          this.untilAbandoned(
            signal,
            this.untilDeadline(
              args.timeout_ms,
              this.waitForOutcome(state, callId, entry.settled, lease),
            ),
          ),
        );
    // A collection that stopped waiting must stop LISTENING too: left
    // registered, its waiter would accept a later question from another call
    // and hand it to a reply that has already been sent.
    if (envelope === ABANDONED || envelope === TIMED_OUT) {
      lease.release();
    }
    // The request is GONE — its socket closed while this collection was
    // blocked. Consuming here is what cost a caller a whole callee turn: the
    // entry is deleted, `await_collected` is written, and the envelope is
    // handed to a reply nobody will read, so the retry is told UNKNOWN_CALL
    // and the work is unreachable for the rest of the run.
    if (envelope === ABANDONED) {
      return {
        status: 'error',
        error: `AWAIT_ABANDONED: the request collecting '${callId}' ended before the callee did — the result is still collectable`,
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
        call_id: callId,
        agent: entry.calleeId,
      };
    }
    if (envelope.status === 'question') {
      // The TTL counts from the moment the caller can actually SEE the
      // question, not from the park — this is the one delivery that is
      // observed rather than assumed. The envelope's own call id, since a
      // question from ANOTHER call of this caller's can divert this wait.
      this.rearmQuestionTtl(runId, envelope.call_id);
      return envelope;
    }
    // A concurrent waiter may have collected while this one was blocked —
    // collection stays exactly-once (question envelopes are the only
    // non-consuming reads), so the loser is told the call is gone rather
    // than duplicating the await_collected row.
    return (
      this.collect(state, callerNodeId, callId, envelope) ?? {
        status: 'error',
        error: `UNKNOWN_CALL: no un-collected async call '${callId}' started by you`,
      }
    );
  }

  /**
   * Consume one settled call's result, exactly once — null when a concurrent
   * collection already took it.
   */
  private collect(
    state: RunCallState,
    callerNodeId: string,
    callId: string,
    envelope: CallEnvelope,
  ): CallEnvelope | null {
    if (!state.pendingAsync.has(callId)) {
      return null;
    }
    state.pendingAsync.delete(callId);
    state.capability.persistItem(callerNodeId, 'await_collected', null, {
      callId,
      callerNodeId,
    });
    return envelope;
  }

  /**
   * await_agent with no call_id: wait on EVERY call the caller has open and
   * return the first thing any of them produces — a question, or a finished
   * result — naming the call it came from. What a caller that fanned out work
   * needs: waiting on one call while another finished or asked is how a
   * question sat unseen until it timed out.
   *
   * An unseen question and an already-settled result are answered at once;
   * otherwise one waiter per call races, and every one is released when the
   * wait ends however it ends. The others stay collectable.
   */
  private async awaitAny(
    runId: string,
    state: RunCallState,
    callerNodeId: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CallEnvelope> {
    const abandoned: CallEnvelope = {
      status: 'error',
      error:
        'AWAIT_ABANDONED: the request ended before any call produced anything — every call is still collectable',
    };
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    // A LOOP because a result can be taken by a concurrent collection between
    // the race and the collect; the calls still open are then waited on again
    // rather than the caller being told about a call that is not its to take.
    for (;;) {
      const open = [...state.pendingAsync].filter(
        ([, entry]) => entry.owner === callerNodeId,
      );
      if (open.length === 0) {
        return {
          status: 'error',
          error:
            'NO_OPEN_CALLS: you have no un-collected calls — start one with call_agent first',
        };
      }
      if (signal?.aborted) {
        return abandoned;
      }
      for (const [callId] of open) {
        const call = state.activeCalls.get(callId);
        if (call?.parked && !call.parked.envelopeDelivered) {
          markEnvelopeDelivered(call);
          this.rearmQuestionTtl(runId, callId);
          return questionEnvelope(callId, call);
        }
      }
      // Every open call is waiting on an answer the caller has already been
      // shown: waiting would only run those questions out of time, so they are
      // shown again instead.
      const parkedCall = open
        .map(([callId]) => [callId, state.activeCalls.get(callId)] as const)
        .find(([, call]) => call?.parked);
      if (
        parkedCall !== undefined &&
        open.every(([callId]) => state.activeCalls.get(callId)?.parked)
      ) {
        return questionEnvelope(parkedCall[0], parkedCall[1]!);
      }
      let collectedSettled: CallEnvelope | null = null;
      for (const [callId, entry] of open) {
        if (!state.activeCalls.has(callId)) {
          const settled = await entry.settled;
          const collected = this.collect(state, callerNodeId, callId, settled);
          if (collected !== null) {
            collectedSettled = withCallId(collected, callId);
            break;
          }
        }
      }
      if (collectedSettled !== null) {
        return collectedSettled;
      }
      const leases: WaitLease[] = [];
      const questionsSeen: string[] = [];
      // The question the race returned: undefined until it is decided, null
      // when it returned a result instead.
      let shown: string | null | undefined;
      const first = Promise.race(
        open.map(([callId, entry]) => {
          const lease: WaitLease = { release: () => {} };
          leases.push(lease);
          return this.listen(state, callId, entry.settled, lease).then(
            (envelope) => {
              if (envelope.status === 'question') {
                questionsSeen.push(envelope.call_id);
                if (shown !== undefined && shown !== envelope.call_id) {
                  this.unseeQuestion(state, envelope.call_id);
                }
              }
              return { callId, envelope };
            },
          );
        }),
      ).then((outcome) => {
        shown =
          outcome.envelope.status === 'question'
            ? outcome.envelope.call_id
            : null;
        return outcome;
      });
      const outcome = await this.whileWaiting(state, callerNodeId, () =>
        this.untilAbandoned(
          signal,
          this.untilDeadline(
            deadline === null ? undefined : Math.max(0, deadline - Date.now()),
            first,
          ),
        ),
      );
      for (const lease of leases) {
        lease.release();
      }
      if (typeof outcome === 'symbol') {
        shown = null;
      }
      // A question that reached a waiter which then lost the race was marked
      // delivered and shown to nobody — put it back for the next wait.
      for (const callId of questionsSeen) {
        if (callId !== shown) {
          this.unseeQuestion(state, callId);
        }
      }
      if (outcome === ABANDONED) {
        return abandoned;
      }
      if (outcome === TIMED_OUT) {
        const waitingOn = open.map(([callId, entry]) => ({
          call_id: callId,
          agent: entry.calleeId,
        }));
        return { status: 'pending', ...waitingOn[0]!, waiting_on: waitingOn };
      }
      if (outcome.envelope.status === 'question') {
        this.rearmQuestionTtl(runId, outcome.envelope.call_id);
        return outcome.envelope;
      }
      const collected = this.collect(
        state,
        callerNodeId,
        outcome.callId,
        outcome.envelope,
      );
      if (collected !== null) {
        return withCallId(collected, outcome.callId);
      }
    }
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
      return this.unknownCall(state, args.call_id, 'live call');
    }
    const parked = call.parked;
    if (!parked) {
      return {
        status: 'error',
        error: `NO_QUESTION: call '${args.call_id}' has no outstanding question (already answered, or still running)`,
      };
    }
    this.unpark(state, args.call_id, call);
    // The callee is working again — its silence window, stood down while it
    // waited on this answer, starts over from here.
    this.armSilenceWatch(runId, args.call_id, call);
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
    call.parked = {
      question: input.question,
      options: input.options,
      // Armed below, so a question parked while its owner is blocked on a
      // card of its own starts suspended rather than counting down toward a
      // caller that cannot answer.
      timer: null,
      ttlMs,
      deliver: input.deliver,
      fail: input.fail,
      ownerTold: false,
      envelopeDelivered: false,
    };
    this.rearmQuestionTtl(runId, callId);
    // The callee is now waiting on ITS caller, so it cannot answer the
    // questions its own callees park — theirs wait with it.
    this.blockOwner(state, call.calleeId, parkBlocker(callId));
    // A parked callee emits nothing by construction — it is waiting on its
    // caller — so its silence window stands down exactly as it does behind an
    // approval card, and restarts when the answer lands.
    if (call.silence !== null) {
      clearTimeout(call.silence);
      call.silence = null;
    }
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
    makeCollectable(state, callId, call);
    // A caller whose turns have all ENDED is woken with the question rather
    // than having its callee killed under it. Orphaning here is what made a
    // workflow "stop in the middle without any error": a Manager said "I'll
    // report back" and ended its turn, its Engineer then asked something, and
    // the Engineer was cancelled while the run closed as completed. It is
    // orphaned only when there is no turn left to give the caller.
    const ownerLive = state.capability.isNodeLive(call.owner);
    if (!ownerLive && !this.wakeOwner(runId, state, call.owner, [callId], [])) {
      this.orphan(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
      );
      return true;
    }
    if (!this.handToWaiter(state, callId, call) && ownerLive) {
      this.tellWorkingOwner(state, call.owner, callId);
    }
    return true;
  }

  /**
   * Put a freshly parked question in front of a caller that is BLOCKED on one
   * of its calls: a wait on this call first, else a wait on any other call the
   * same caller owns. A caller blocked in await_agent on call-5 cannot read a
   * message, so a question from call-7 that waited for an await on call-7
   * reached nobody and timed out. The interrupted call stays collectable.
   */
  private handToWaiter(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): boolean {
    const envelope = questionEnvelope(callId, call);
    if (notifyWaiters(call, envelope)) {
      markEnvelopeDelivered(call);
      return true;
    }
    for (const [otherId, other] of state.activeCalls) {
      if (otherId === callId || other.owner !== call.owner) {
        continue;
      }
      if (notifyWaiters(other, { ...envelope, still_running: otherId })) {
        markEnvelopeDelivered(call);
        makeCollectable(state, otherId, other);
        return true;
      }
    }
    return false;
  }

  /**
   * A caller that is working but waiting on none of its calls — running its
   * own tools, or thinking — is handed the question inside its running turn,
   * where its CLI can take a message without interrupting (otherwise its next
   * wait delivers it — see `waitForOutcome`). `ownerTold` stays false: a
   * message joining a turn at its next tool boundary is not an observed
   * delivery, so a caller that ends without answering still earns the one wake
   * `drainCaller` gives.
   */
  private tellWorkingOwner(
    state: RunCallState,
    owner: string,
    callId: string,
  ): void {
    const call = state.activeCalls.get(callId);
    if (!call?.parked) {
      return;
    }
    const asked: WakeQuestion = {
      callId,
      callee: this.calleeName(state, owner, call.calleeId),
      question: call.parked.question,
      options: call.parked.options,
    };
    if (!state.capability.tellLiveNode(owner, wakePrompt([asked], [], true))) {
      return;
    }
    state.capability.persistItem(owner, 'system', null, {
      severity: 'info',
      message: `Passed ${asked.callee}'s question in ${callId} to this agent while it was working.`,
    });
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
    // Its cards went with its turn (the executor sweeps them beside this
    // call), so nothing blocks it any more — and a blocker left over here would
    // keep every question it is woken with suspended for good.
    state.blockedOwners.delete(callerNodeId);
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
    const parked = this.unpark(state, callId, call);
    if (!parked) {
      return;
    }
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
  private unseeQuestion(state: RunCallState, callId: string): void {
    const parked = state.activeCalls.get(callId)?.parked;
    if (parked) {
      parked.envelopeDelivered = false;
    }
  }

  /**
   * One waiter on a call: its question the moment one parks, else its final
   * envelope. No handoffs — the caller decides those.
   */
  private listen(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
    lease: WaitLease,
  ): Promise<CallEnvelope> {
    const call = state.activeCalls.get(callId);
    if (!call) {
      return settled;
    }
    return new Promise((resolve) => {
      let done = false;
      const once = (envelope: CallEnvelope): boolean => {
        if (done) {
          return false;
        }
        done = true;
        resolve(envelope);
        return true;
      };
      call.questionWaiters.push(once);
      void call.settled.then(once);
      lease.release = () => {
        done = true;
        const at = call.questionWaiters.indexOf(once);
        if (at !== -1) {
          call.questionWaiters.splice(at, 1);
        }
      };
    });
  }

  private waitForOutcome(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
    lease?: WaitLease,
  ): Promise<CallEnvelope> {
    const call = state.activeCalls.get(callId);
    if (!call) {
      return settled;
    }
    if (call.parked) {
      markEnvelopeDelivered(call);
      return Promise.resolve(questionEnvelope(callId, call));
    }
    // A question one of this caller's OTHER calls parked while it was not
    // waiting — between two awaits, or busy with its own tools — is handed to
    // the next wait it starts. Otherwise that wait (routinely a five-minute
    // await on a different call) runs out the question's whole window, which
    // is QUESTION_TIMEOUT on a caller that was never shown the question.
    for (const [otherId, other] of state.activeCalls) {
      if (
        otherId !== callId &&
        other.owner === call.owner &&
        other.parked !== null &&
        !other.parked.envelopeDelivered
      ) {
        markEnvelopeDelivered(other);
        makeCollectable(state, callId, call);
        return Promise.resolve({
          ...questionEnvelope(otherId, other),
          still_running: callId,
        });
      }
    }
    return new Promise((resolve) => {
      let done = false;
      const once = (envelope: CallEnvelope): boolean => {
        if (done) {
          return false;
        }
        done = true;
        resolve(envelope);
        return true;
      };
      call.questionWaiters.push(once);
      void call.settled.then(once);
      if (lease) {
        lease.release = () => {
          done = true;
          const at = call.questionWaiters.indexOf(once);
          if (at !== -1) {
            call.questionWaiters.splice(at, 1);
          }
        };
      }
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
   * The callee started a tool call — SUSPEND its silence watchdog until the
   * tool answers ({@link ActiveCall.openToolCalls}).
   *
   * Called by the executor at the same seam as {@link noteCalleeActivity},
   * which is the only place a callee's tool calls are visible from.
   */
  noteCalleeToolStarted(
    runId: string,
    callId: string,
    toolCallId: string,
  ): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.openToolCalls.add(toolCallId);
    if (call.silence !== null) {
      clearTimeout(call.silence);
      call.silence = null;
    }
  }

  /**
   * A callee's tool call answered — restart the window once the LAST open one
   * has. A result for a call this never saw start changes nothing.
   */
  noteCalleeToolFinished(
    runId: string,
    callId: string,
    toolCallId: string,
  ): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call?.openToolCalls.delete(toolCallId)) {
      return;
    }
    if (call.openToolCalls.size === 0) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * A card went up for a node — its own AskUserQuestion to the user, or a
   * permission it holds in ask mode — so it cannot answer anything until a
   * person does. Suspend the TTL of every question its callees have parked,
   * and of any they park meanwhile ({@link ParkedQuestion.timer}).
   *
   * Any node, not only a DAG caller: a callee that is itself a caller is
   * blocked by its cards on the same terms.
   *
   * The owner-side twin of {@link noteCalleeBlocked}, called from the same
   * seam: the executor raises the card and receives its verdict, so it knows
   * both moments without a cross-module read. `cardId` names the card, so the
   * same card offered twice is one blocker ({@link RunCallState.blockedOwners}).
   */
  noteCallerBlocked(runId: string, ownerNodeId: string, cardId: string): void {
    const state = this.runs.get(runId);
    if (state) {
      this.blockOwner(state, ownerNodeId, cardId);
    }
  }

  /**
   * A card this node was blocked on has been answered (or has gone away) —
   * once the LAST of its blockers is, every question its callees have parked
   * gets its full window again, counted from now: the node has only now been
   * able to read it.
   *
   * A card it never noted is a no-op rather than an error: a settle sweeps
   * cards that were never answered, and the card is gone on every `respond`,
   * delivered or not.
   */
  noteCallerUnblocked(
    runId: string,
    ownerNodeId: string,
    cardId: string,
  ): void {
    const state = this.runs.get(runId);
    if (state) {
      this.unblockOwner(state, ownerNodeId, cardId);
    }
  }

  /** Add one blocker to a node, suspending its callees' questions on the first. */
  private blockOwner(
    state: RunCallState,
    owner: string,
    blocker: string,
  ): void {
    const blockers = state.blockedOwners.get(owner) ?? new Set<string>();
    const wasBlocked = blockers.size > 0;
    blockers.add(blocker);
    state.blockedOwners.set(owner, blockers);
    if (wasBlocked) {
      return;
    }
    for (const [callId, call] of state.activeCalls) {
      if (call.owner === owner && call.parked) {
        this.rearmQuestionTtl(state.runId, callId);
      }
    }
  }

  /** Remove one blocker; the last one gives its callees' questions full windows. */
  private unblockOwner(
    state: RunCallState,
    owner: string,
    blocker: string,
  ): void {
    const blockers = state.blockedOwners.get(owner);
    if (!blockers?.delete(blocker) || blockers.size > 0) {
      return;
    }
    state.blockedOwners.delete(owner);
    for (const [callId, call] of state.activeCalls) {
      if (call.owner === owner && call.parked) {
        this.rearmQuestionTtl(state.runId, callId);
      }
    }
  }

  /**
   * Take a parked question down — its clock stopped, and its callee no longer
   * blocked by it — and hand back what was parked, or null when nothing was.
   *
   * The ONE way out of a park, so a new way for a question to end cannot leave
   * the callee blocked with nothing left to release it.
   */
  private unpark(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): ParkedQuestion | null {
    const parked = call.parked;
    if (!parked) {
      return null;
    }
    call.parked = null;
    stopQuestionTimer(parked);
    this.unblockOwner(state, call.calleeId, parkBlocker(callId));
    return parked;
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
    // suspends the window would immediately re-arm it. A PARKED one too —
    // waiting on its caller's answer is the same silence.
    // And one waiting on its own tool call, for the same reason: the tool call
    // is persisted as a row too, and it is what starts the wait.
    if (
      call.blockedOnVerdicts > 0 ||
      call.parked !== null ||
      call.openToolCalls.size > 0
    ) {
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
   * handed it — or SUSPEND it, when the caller is blocked on a card of its
   * own and so could not be handed anything ({@link ParkedQuestion.timer}).
   *
   * A no-op for a call that is no longer parked (answered, failed, gone), so a
   * late collection cannot resurrect a clock on a question that is over.
   */
  private rearmQuestionTtl(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    const parked = call?.parked;
    if (!state || !call || !parked) {
      return;
    }
    stopQuestionTimer(parked);
    if ((state.blockedOwners.get(call.owner)?.size ?? 0) > 0) {
      return;
    }
    parked.timer = setTimeout(
      () => this.expireQuestion(runId, callId),
      parked.ttlMs,
    );
    parked.timer.unref?.();
  }

  /**
   * The UNKNOWN_CALL refusal — and, for an id from BEFORE the daemon
   * restarted, the reason it is unknown, since "no such call" is exactly what
   * a caller reading its own transcript cannot square: the call is right
   * there. Its result died with that daemon; what survives is the thread,
   * when the callee recorded a session, and the sentence says so.
   */
  private unknownCall(
    state: RunCallState,
    callId: string,
    what: string,
  ): CallEnvelope {
    const number = callNumber(callId);
    if (
      number !== null &&
      number <= state.seededCallSeq &&
      !state.activeCalls.has(callId) &&
      !state.pendingAsync.has(callId)
    ) {
      const resumable = (state.threads.get(callId)?.sessionId ?? null) !== null;
      return {
        status: 'error',
        error: `UNKNOWN_CALL: '${callId}' was made before the daemon restarted and its result did not survive — call the agent again${resumable ? ` (thread: '${callId}' continues that conversation)` : ''}`,
      };
    }
    return {
      status: 'error',
      error: `UNKNOWN_CALL: no ${what} '${callId}' started by you`,
    };
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

/**
 * The blocker a callee holds while its question in `callId` waits on its
 * caller — named apart from the executor's card ids, which carry a session key.
 */
function parkBlocker(callId: string): string {
  return `park:${callId}`;
}

/** Stop a parked question's clock, whether or not one is running. */
function stopQuestionTimer(parked: ParkedQuestion): void {
  if (parked.timer !== null) {
    clearTimeout(parked.timer);
    parked.timer = null;
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

function markEnvelopeDelivered(call: ActiveCall): void {
  if (call.parked) {
    call.parked.envelopeDelivered = true;
  }
}

/**
 * A call whose wait a question diverted becomes await_agent-collectable: a
 * sync call's result had exactly one collector, and it just went to the
 * question instead.
 */
function makeCollectable(
  state: RunCallState,
  callId: string,
  call: ActiveCall,
): void {
  if (!state.pendingAsync.has(callId)) {
    state.pendingAsync.set(callId, {
      owner: call.owner,
      calleeId: call.calleeId,
      settled: call.settled,
      told: false,
    });
  }
}

/** An envelope stamped with the call it came from, for a wait over several. */
function withCallId(envelope: CallEnvelope, callId: string): CallEnvelope {
  return envelope.status === 'error'
    ? { ...envelope, call_id: callId }
    : envelope;
}

/** Resolve every waiter on `call`; true when at least one was still waiting. */
function notifyWaiters(call: ActiveCall, envelope: CallEnvelope): boolean {
  let delivered = false;
  for (const notify of call.questionWaiters.splice(0)) {
    delivered = notify(envelope) || delivered;
  }
  return delivered;
}

function questionEnvelope(
  callId: string,
  call: ActiveCall,
): Extract<CallEnvelope, { status: 'question' }> {
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
