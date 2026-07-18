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
  /** The node's most recent status transition; null before its first one. */
  lastStatus: NodeRunStatus | null;
  /** Prompt-side tokens of the agent's LATEST settled turn (its context). */
  contextTokens: number | null;
  /** Cumulative cost across all of the agent's settled turns. */
  spentUsd: number | null;
}

/** The activity-map key for single-agent chat items (their nodeId is null). */
export const CHAT_AGENT_KEY = 'agent';

/**
 * One agent as the header chips and the agents panel display it — workflow
 * node metadata merged with its live {@link AgentActivity}.
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
        lastStatus: null,
        contextTokens: null,
        spentUsd: null,
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
      } else if (status !== 'pending') {
        // A terminal transition settles ONE live turn. `skipped` (and a
        // defensive clamp) can arrive without a matching start — never
        // go negative.
        agent.activeTurns = Math.max(0, agent.activeTurns - 1);
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
