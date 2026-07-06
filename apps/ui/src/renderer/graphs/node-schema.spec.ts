import { describe, expect, it } from 'vitest';

import {
  AGENT_MODEL_OPTIONS,
  canConnect,
  makeHandleId,
  NODE_TYPE_SCHEMAS,
} from './node-schema';

describe('canConnect (real registry)', () => {
  it('allows agent → agent and trigger → agent', () => {
    expect(canConnect('agent', 'agent')).toBe(true);
    expect(canConnect('trigger', 'agent')).toBe(true);
  });

  it('refuses agent → trigger and trigger → trigger (no input rules on trigger)', () => {
    expect(canConnect('agent', 'trigger')).toBe(false);
    expect(canConnect('trigger', 'trigger')).toBe(false);
  });

  it('requires BOTH sides — an output rule alone is not enough', () => {
    // sink accepts nothing, yet the source outputs to agents: input side vetoes.
    const rules = {
      agent: { inputs: [], outputs: [{ kind: 'agent' }] },
    };
    expect(canConnect('agent', 'agent', rules)).toBe(false);
  });

  it('refuses unknown kinds instead of throwing', () => {
    expect(canConnect('mystery', 'agent')).toBe(false);
    expect(canConnect('agent', 'mystery')).toBe(false);
  });
});

describe('NODE_TYPE_SCHEMAS', () => {
  it('every kind shares the same envelope, then its own fields', () => {
    const agentKeys = NODE_TYPE_SCHEMAS.agent.map((f) => f.key);
    const triggerKeys = NODE_TYPE_SCHEMAS.trigger.map((f) => f.key);
    // The shared envelope leads both schemas, in the same order.
    expect(agentKeys.slice(0, 3)).toEqual(['id', 'kind', 'name']);
    expect(triggerKeys.slice(0, 3)).toEqual(['id', 'kind', 'name']);
    expect(agentKeys).toEqual([
      'id',
      'kind',
      'name',
      'agent',
      'model',
      'role',
      'approval',
    ]);
    expect(triggerKeys).toEqual(['id', 'kind', 'name', 'trigger']);
  });
});

describe('AGENT_MODEL_OPTIONS', () => {
  it('offers each CLI its own documented model aliases', () => {
    // Pinned literally: these are the aliases each CLI's `--model` help
    // documents — the select passes them straight through to the flag.
    expect(AGENT_MODEL_OPTIONS.claude).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect(AGENT_MODEL_OPTIONS['cursor-agent']).toEqual([
      'gpt-5',
      'sonnet-4',
      'sonnet-4-thinking',
    ]);
  });
});

describe('makeHandleId', () => {
  it('derives the per-rule handle id from direction + peer kind', () => {
    // Pinned literally: toFlow derives these for STORED edges and the ports
    // block renders Handles under them — a drifted scheme silently detaches
    // every persisted edge from its handle.
    expect(makeHandleId('target', 'trigger')).toBe('target-kind-trigger');
    expect(makeHandleId('target', 'agent')).toBe('target-kind-agent');
    expect(makeHandleId('source', 'agent')).toBe('source-kind-agent');
  });
});
