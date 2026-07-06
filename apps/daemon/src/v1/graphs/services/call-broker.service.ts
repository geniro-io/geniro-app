import { Injectable } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import type { WorkflowAgentNode } from '../graphs.types';

/** How a caller wants its call to behave (the call_agent `mode` argument). */
export type CallMode = 'sync' | 'async' | 'fire_and_forget';

/** How one callee sub-turn ended, as the executor reports it to the broker. */
export interface CalleeTurnOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string | null;
  error: string | null;
}

/**
 * The envelope every call tool returns — NEVER bare text, so milestone 4's
 * `status: 'question'` (the Q&A bridge) extends the contract without breaking
 * existing callers. A discriminated union so an `ok` envelope always carries
 * `result` and an `error` always carries `error` — the illegal mixed shapes
 * are unrepresentable, and the JSON serializes identically to the old
 * optional-field form. `result` carries `{ call_id, agent, text }` for a
 * settled call and `{ call_id, agent, state }` for an accepted async/
 * fire-and-forget start; `error` is a machine-prefixed one-liner
 * (`DEPTH_LIMIT: …`). Milestone 4 adds a `{ status: 'question'; … }` arm.
 */
export type CallEnvelope =
  { status: 'ok'; result: unknown } | { status: 'error'; error: string };

/** The run has no live call surface — reused by call_agent and await_agent. */
const RUN_NOT_ACTIVE: CallEnvelope = {
  status: 'error',
  error: 'RUN_NOT_ACTIVE: this run is not accepting agent calls',
};

/**
 * What the graph executor exposes to the broker for one live run — the
 * capability seam. The broker owns call SEMANTICS (ids, caps, sync/async
 * bookkeeping); the executor owns MECHANICS (spawning the callee turn,
 * transcript persistence, slot accounting, cancellation fan-out).
 */
export interface RunCallCapability {
  /** Callees each caller may invoke: caller node id → callee agent nodes. */
  readonly calleesOf: ReadonlyMap<string, readonly WorkflowAgentNode[]>;
  /**
   * Spawn one fresh callee turn; resolves once the turn fully settles.
   * `depth` is the call's chain depth (1 = a top-level caller's callee): the
   * executor bounds only depth-1 turns with its sub-turn slot pool, so a
   * nested sync chain can't hold every slot while blocked on a deeper call.
   */
  launchCalleeTurn(
    callee: WorkflowAgentNode,
    message: string,
    callId: string,
    depth: number,
  ): Promise<CalleeTurnOutcome>;
  /** Persist one transcript item on the run's serialized write chain. */
  persistItem(
    nodeId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): void;
  /** True once the run's cancel was requested — refuse new calls. */
  isCancelled(): boolean;
}

/**
 * Call-chain depth cap: a DAG-launched caller sits at depth 0, its callee at
 * 1, a call made BY that callee lands at 2… — 3 keeps A→B→C legal while
 * braking runaway mutual-call loops (which the total-turns cap hard-stops).
 */
const MAX_CALL_DEPTH = 3;

/** Hard per-run stop on callee turns — the runaway-loop backstop. */
const MAX_CALL_TURNS_PER_RUN = 50;

interface AsyncCallEntry {
  /** The caller that started the call — only it may collect the result. */
  owner: string;
  settled: Promise<CallEnvelope>;
}

interface RunCallState {
  capability: RunCallCapability;
  callSeq: number;
  turnsStarted: number;
  /** Live callee turns: call id → callee node + its chain depth. */
  activeCalls: Map<string, { calleeId: string; depth: number }>;
  /** Async results retained until their caller collects them. */
  pendingAsync: Map<string, AsyncCallEntry>;
}

/**
 * Agent-to-agent call semantics over the executor's capability seam: call
 * ids, the depth and total-turns caps, sync waiting, async + await_agent
 * collection, and fire-and-forget. One instance serves every run; state is
 * per-run and dies with `unregisterRun` (in-memory only — a call never
 * outlives its run). Modeled on ApprovalRegistry's pending round-trip.
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
    });
  }

  /** Drop a settled run's state (uncollected async results included). */
  unregisterRun(runId: string): void {
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
   * The call_agent tool. Sync resolves with the callee's settled envelope;
   * async/fire-and-forget resolve immediately with `{ call_id, state }` —
   * async results are retained for await_agent, fire-and-forget results go
   * to the transcript only.
   */
  async callAgent(
    runId: string,
    callerNodeId: string,
    args: { agent: string; message: string; mode?: CallMode },
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
    state.turnsStarted += 1;
    state.callSeq += 1;
    const callId = `call-${state.callSeq}`;
    const mode: CallMode = args.mode ?? 'sync';
    state.activeCalls.set(callId, { calleeId: callee.id, depth });
    state.capability.persistItem(callerNodeId, 'call_started', null, {
      callId,
      callerNodeId,
      calleeNodeId: callee.id,
      mode,
      message: args.message,
    });

    const settled = state.capability
      .launchCalleeTurn(callee, args.message, callId, depth)
      .then((outcome) => toEnvelope(callId, callee.id, outcome))
      .catch((err: unknown): CallEnvelope => ({
        status: 'error',
        error: `CALL_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((envelope) => {
        state.activeCalls.delete(callId);
        state.capability.persistItem(callerNodeId, 'call_result', null, {
          callId,
          callerNodeId,
          calleeNodeId: callee.id,
          mode,
          ...envelope,
        });
        return envelope;
      });

    if (mode === 'sync') {
      return settled;
    }
    if (mode === 'async') {
      state.pendingAsync.set(callId, { owner: callerNodeId, settled });
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

  /** The await_agent tool: collect one of the caller's own async results. */
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
    state.pendingAsync.delete(args.call_id);
    const envelope = await entry.settled;
    state.capability.persistItem(callerNodeId, 'await_collected', null, {
      callId: args.call_id,
      callerNodeId,
    });
    return envelope;
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
