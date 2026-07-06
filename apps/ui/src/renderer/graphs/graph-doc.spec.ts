import { describe, expect, it } from 'vitest';

import type { Workflow } from '../../shared/contracts';
import { autoLayout, edgeId, fromFlow, nextNodeId, toFlow } from './graph-doc';

const WF: Workflow = {
  name: 'team',
  nodes: [
    {
      id: 'coder',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      role: 'You code.',
    },
    { id: 'reviewer', kind: 'agent', agent: 'cursor-agent', approval: 'ask' },
  ],
  edges: [{ from: 'coder', to: 'reviewer' }],
  layout: { coder: { x: 10, y: 20 } },
};

describe('toFlow / fromFlow', () => {
  it('round-trips a workflow through the canvas document', () => {
    const flow = toFlow(WF);
    expect(flow.nodes.map((n) => n.id)).toEqual(['coder', 'reviewer']);
    // Stored position wins; missing position falls back to the grid.
    expect(flow.nodes[0]!.position).toEqual({ x: 10, y: 20 });
    expect(flow.nodes[1]!.position).toEqual({ x: 260, y: 0 });
    expect(flow.edges).toEqual([
      {
        id: 'coder->reviewer',
        source: 'coder',
        target: 'reviewer',
        label: undefined,
        // Handles derive from the endpoint kinds (both agents here) and are
        // never persisted — fromFlow drops them below.
        sourceHandle: 'source-kind-agent',
        targetHandle: 'target-kind-agent',
      },
    ]);

    const back = fromFlow({ name: WF.name }, flow.nodes, flow.edges);
    expect(back.nodes).toEqual(WF.nodes);
    expect(back.edges).toEqual([{ from: 'coder', to: 'reviewer' }]);
    // Every node position (including the fallback) persists into the layout.
    expect(back.layout).toEqual({
      coder: { x: 10, y: 20 },
      reviewer: { x: 260, y: 0 },
    });
  });

  it('maps node kinds to their RF component types and round-trips a trigger', () => {
    const flow = toFlow({
      name: 'triggered',
      nodes: [{ id: 'start', kind: 'trigger', trigger: 'manual' }, ...WF.nodes],
      edges: [{ from: 'start', to: 'coder' }, ...WF.edges],
    });
    expect(flow.nodes.map((n) => n.type)).toEqual([
      'trigger',
      'agent',
      'agent',
    ]);
    // A trigger→agent edge lands on the agent's trigger-typed input handle.
    expect(flow.edges[0]).toMatchObject({
      source: 'start',
      target: 'coder',
      sourceHandle: 'source-kind-agent',
      targetHandle: 'target-kind-trigger',
    });
    const back = fromFlow({ name: 'triggered' }, flow.nodes, flow.edges);
    expect(back.nodes[0]).toEqual({
      id: 'start',
      kind: 'trigger',
      trigger: 'manual',
    });
  });

  it('keeps edge labels when present', () => {
    const flow = toFlow({
      ...WF,
      edges: [{ from: 'coder', to: 'reviewer', label: 'diff' }],
    });
    const back = fromFlow({ name: 'x' }, flow.nodes, flow.edges);
    expect(back.edges[0]).toEqual({
      from: 'coder',
      to: 'reviewer',
      label: 'diff',
    });
  });
});

describe('nextNodeId', () => {
  it('skips taken ids', () => {
    expect(nextNodeId(new Set(['agent-1', 'agent-2']))).toBe('agent-3');
    expect(nextNodeId(new Set())).toBe('agent-1');
  });

  it('prefixes by node kind', () => {
    expect(nextNodeId(new Set(['agent-1']), 'trigger')).toBe('trigger-1');
    expect(nextNodeId(new Set(['trigger-1']), 'trigger')).toBe('trigger-2');
  });
});

describe('edgeId', () => {
  it('is stable per endpoint pair', () => {
    expect(edgeId('a', 'b')).toBe('a->b');
  });
});

describe('autoLayout', () => {
  it('positions every node with producers left of consumers', async () => {
    const layout = await autoLayout(WF);
    expect(Object.keys(layout).sort()).toEqual(['coder', 'reviewer']);
    expect(layout.coder!.x).toBeLessThan(layout.reviewer!.x);
  });
});
