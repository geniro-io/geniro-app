import { describe, expect, it } from 'vitest';

import type { ChatItem } from '../../shared/contracts';
import {
  CHAT_AGENT_KEY,
  computeAgentActivity,
  formatTokens,
  formatUsd,
} from './agent-activity';

let seq = 0;
function item(
  kind: ChatItem['kind'],
  nodeId: string | null,
  payload: unknown,
): ChatItem {
  seq += 1;
  return {
    id: `i${seq}`,
    runId: 'r1',
    nodeId,
    seq,
    kind,
    role: null,
    payload,
    createdAt: 'now',
  };
}

function status(nodeId: string, value: string): ChatItem {
  return item('status', nodeId, { nodeId, status: value });
}

describe('computeAgentActivity', () => {
  it('counts PARALLEL live turns per agent (two starts, one settle → 1 live)', () => {
    // An orchestrator can call_agent the same worker twice concurrently —
    // each callee sub-turn emits its own running/terminal status pair.
    const activity = computeAgentActivity([
      status('worker', 'running'),
      status('worker', 'running'),
      status('worker', 'completed'),
    ]);
    expect(activity.get('worker')?.activeTurns).toBe(1);
    expect(activity.get('worker')?.lastStatus).toBe('completed');

    const settled = computeAgentActivity([
      status('worker', 'running'),
      status('worker', 'running'),
      status('worker', 'completed'),
      status('worker', 'failed'),
    ]);
    expect(settled.get('worker')?.activeTurns).toBe(0);
    expect(settled.get('worker')?.lastStatus).toBe('failed');
  });

  it('never goes negative on a settle without a matching start (skipped nodes)', () => {
    const activity = computeAgentActivity([status('worker', 'skipped')]);
    expect(activity.get('worker')?.activeTurns).toBe(0);
    expect(activity.get('worker')?.lastStatus).toBe('skipped');
  });

  it('tracks context (latest turn) and spend (cumulative) from turn_complete usage', () => {
    const activity = computeAgentActivity([
      item('turn_complete', 'worker', {
        usage: { inputTokens: 10, contextTokens: 5_000, costUsd: 0.1 },
        stopReason: null,
      }),
      item('turn_complete', 'worker', {
        usage: { inputTokens: 20, contextTokens: 12_000, costUsd: 0.25 },
        stopReason: null,
      }),
    ]);
    const worker = activity.get('worker');
    expect(worker?.contextTokens).toBe(12_000);
    expect(worker?.spentUsd).toBeCloseTo(0.35);
  });

  it('falls back to inputTokens when a CLI reports no contextTokens', () => {
    const activity = computeAgentActivity([
      item('turn_complete', 'worker', {
        usage: { inputTokens: 42, costUsd: null },
        stopReason: null,
      }),
    ]);
    expect(activity.get('worker')?.contextTokens).toBe(42);
    expect(activity.get('worker')?.spentUsd).toBeNull();
  });

  it("keys a single-agent chat's null-node items under CHAT_AGENT_KEY", () => {
    const activity = computeAgentActivity([
      item('turn_complete', null, {
        usage: { contextTokens: 900, costUsd: 0.02 },
        stopReason: null,
      }),
    ]);
    expect(activity.get(CHAT_AGENT_KEY)?.contextTokens).toBe(900);
  });

  it('ignores malformed status payloads and null usage', () => {
    const activity = computeAgentActivity([
      item('status', 'worker', { nodeId: 'worker', status: 42 }),
      item('status', 'worker', 'not-an-object'),
      item('turn_complete', 'worker', { usage: null, stopReason: null }),
    ]);
    expect(activity.get('worker')).toBeUndefined();
  });
});

describe('formatTokens / formatUsd', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(45_000)).toBe('45k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
  });

  it('formats spend with a sub-cent floor', () => {
    expect(formatUsd(0.236)).toBe('$0.24');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(0)).toBe('$0.00');
  });
});
