import { describe, expect, it } from 'vitest';

import type { Workflow } from '../../shared/contracts';
import { autoLayout, edgeId, fromFlow, nextNodeId, toFlow } from './graph-doc';

const WF: Workflow = {
  name: 'team',
  nodes: [
    { id: 'coder', agent: 'claude', approval: 'auto', role: 'You code.' },
    { id: 'reviewer', agent: 'cursor-agent', approval: 'ask' },
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
