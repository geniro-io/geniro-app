import type { ChatItem, CliKind, NodeRunStatus } from '../../shared/contracts';
import type { RunStatusKind } from './run-status';

/**
 * Live per-agent execution state, derived purely from a run's transcript
 * items. Every turn an agent node runs — DAG-scheduled or a callee sub-turn
 * started by `call_agent` — emits a `status` item `{nodeId, status:'running'}`
 * on spawn and a terminal one on settle, so the number of currently-live
 * parallel turns is the running count minus the settled count. `turn_complete`
 * items carry the CLI's usage, giving the agent's current context footprint
 * and its cumulative spend.
 */
export interface AgentActivity {
  /** Turns of this agent live RIGHT NOW (an orchestrator can run several). */
  activeTurns: number;
  /** How many turns of this agent have STARTED over the run's lifetime. */
  turnStarts: number;
  /** The node's most recent status transition; null before its first one. */
  lastStatus: NodeRunStatus | null;
  /** Prompt-side tokens of the agent's LATEST settled turn (its context). */
  contextTokens: number | null;
  /** Cumulative cost across all of the agent's settled turns. */
  spentUsd: number | null;
  /**
   * The agent's call threads — one per `call_agent` conversation targeting it,
   * derived from the caller's call_started/call_result items (which carry the
   * callee node id and, on settle, the thread's CLI session id).
   */
  callThreads: AgentCallThread[];
}

/** One `call_agent` conversation of an agent, as the transcript records it. */
export interface AgentCallThread {
  callId: string;
  /** The first message of the thread — its display label. */
  message: string | null;
  status: 'running' | 'completed' | 'failed';
  /** The thread's CLI session id once settled — its terminal/resume handle. */
  sessionId: string | null;
}

/** The activity-map key for single-agent chat items (their nodeId is null). */
export const CHAT_AGENT_KEY = 'agent';

/**
 * One agent as the agents panel displays it — workflow node metadata merged
 * with its live {@link AgentActivity}.
 */
export interface AgentDisplay {
  /** Node id ({@link CHAT_AGENT_KEY} for a single-agent chat). */
  id: string;
  name: string;
  /** The CLI driving it; null for a node no longer in the workflow. */
  agent: CliKind | null;
  status: RunStatusKind;
  activeTurns: number;
  contextTokens: number | null;
  spentUsd: number | null;
  /** Every conversation the agent has run — the panel's expandable list. */
  threads: AgentThread[];
}

/** One conversation of an agent, as the agents panel lists it. */
export interface AgentThread {
  /** 'main' for the node's own DAG/chat conversation, else the call id. */
  id: string;
  kind: 'main' | 'call';
  label: string;
  status: RunStatusKind;
  /**
   * Resume handle for a call thread's terminal (from its call_result item);
   * null for main threads — the daemon resolves those from node_state.
   */
  sessionId: string | null;
}

/**
 * The display threads an agent's activity implies: its main conversation
 * (when the node ran a DAG turn — detected as more turn starts than call
 * threads) followed by each call thread.
 */
export function threadsOf(activity: AgentActivity | undefined): AgentThread[] {
  if (!activity) {
    return [];
  }
  const calls = activity.callThreads.map((thread): AgentThread => ({
    id: thread.callId,
    kind: 'call',
    label: thread.message
      ? `${thread.callId} · ${thread.message}`
      : thread.callId,
    status: thread.status,
    sessionId: thread.sessionId,
  }));
  if (activity.turnStarts <= activity.callThreads.length) {
    return calls; // a call-only node never ran a main DAG turn
  }
  const runningCalls = calls.filter((t) => t.status === 'running').length;
  const main: AgentThread = {
    id: 'main',
    kind: 'main',
    label: 'Main conversation',
    // The node's live turns beyond its live calls ARE the main turn; once
    // settled, the node's last transition is the best record of how it ended.
    status:
      activity.activeTurns > runningCalls
        ? 'running'
        : activity.lastStatus && activity.lastStatus !== 'running'
          ? activity.lastStatus
          : 'completed',
    sessionId: null,
  };
  return [main, ...calls];
}

/** The display status an agent's activity implies (any live turn = running). */
export function displayStatus(
  activity: AgentActivity | undefined,
): RunStatusKind {
  if (!activity) {
    return 'idle';
  }
  if (activity.activeTurns > 0) {
    return 'running';
  }
  return activity.lastStatus ?? 'idle';
}

const NODE_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Derive each agent's live state from a run's items (seq-ordered). */
export function computeAgentActivity(
  items: ChatItem[],
): Map<string, AgentActivity> {
  const byAgent = new Map<string, AgentActivity>();
  const entry = (key: string): AgentActivity => {
    let existing = byAgent.get(key);
    if (!existing) {
      existing = {
        activeTurns: 0,
        turnStarts: 0,
        lastStatus: null,
        contextTokens: null,
        spentUsd: null,
        callThreads: [],
      };
      byAgent.set(key, existing);
    }
    return existing;
  };
  for (const item of items) {
    const key = item.nodeId ?? CHAT_AGENT_KEY;
    if (item.kind === 'status') {
      const status = asRecord(item.payload)?.status;
      if (typeof status !== 'string' || !NODE_STATUSES.has(status)) {
        continue;
      }
      const agent = entry(key);
      agent.lastStatus = status as NodeRunStatus;
      if (status === 'running') {
        agent.activeTurns += 1;
        agent.turnStarts += 1;
      } else if (status !== 'pending') {
        // A terminal transition settles ONE live turn. `skipped` (and a
        // defensive clamp) can arrive without a matching start — never
        // go negative.
        agent.activeTurns = Math.max(0, agent.activeTurns - 1);
      }
      continue;
    }
    // Call items are persisted under the CALLER's node — the thread belongs
    // to the CALLEE named in the payload.
    if (item.kind === 'call_started') {
      const payload = asRecord(item.payload);
      const callId = payload?.callId;
      const calleeNodeId = payload?.calleeNodeId;
      if (typeof callId !== 'string' || typeof calleeNodeId !== 'string') {
        continue;
      }
      const message = payload?.message;
      entry(calleeNodeId).callThreads.push({
        callId,
        message: typeof message === 'string' ? message : null,
        status: 'running',
        sessionId: null,
      });
      continue;
    }
    if (item.kind === 'call_result') {
      const payload = asRecord(item.payload);
      const callId = payload?.callId;
      const calleeNodeId = payload?.calleeNodeId;
      if (typeof callId !== 'string' || typeof calleeNodeId !== 'string') {
        continue;
      }
      const thread = entry(calleeNodeId).callThreads.find(
        (t) => t.callId === callId,
      );
      if (!thread) {
        continue;
      }
      thread.status = payload?.status === 'ok' ? 'completed' : 'failed';
      const sessionId = payload?.sessionId;
      if (typeof sessionId === 'string') {
        thread.sessionId = sessionId;
      }
      continue;
    }
    if (item.kind === 'turn_complete') {
      const usage = asRecord(asRecord(item.payload)?.usage);
      if (!usage) {
        continue;
      }
      const agent = entry(key);
      const context = usage.contextTokens ?? usage.inputTokens;
      if (typeof context === 'number') {
        agent.contextTokens = context;
      }
      if (typeof usage.costUsd === 'number') {
        agent.spentUsd = (agent.spentUsd ?? 0) + usage.costUsd;
      }
    }
  }
  return byAgent;
}

/**
 * The context window an agent's fill ring is measured against. The headless
 * CLIs don't report their model's window, so v1 uses the default claude/cursor
 * window; a per-model map can replace this when the CLIs expose it.
 */
export const CONTEXT_WINDOW_TOKENS = 200_000;

/** Compact token count: 950 → "950", 12_400 → "12.4k", 1_200_000 → "1.2M". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(count);
}

/** Compact spend: "$0.24"; sub-cent spend still shows as "<$0.01". */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.01) {
    return '<$0.01';
  }
  return `$${amount.toFixed(2)}`;
}
