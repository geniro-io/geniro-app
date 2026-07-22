import { describe, expect, it } from 'vitest';

import type { Workflow } from '../../shared/contracts';
import {
  autoLayout,
  canvasSnapshot,
  edgeId,
  fromFlow,
  nextNodeId,
  toFlow,
} from './graph-doc';

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
  edges: [{ from: 'coder', to: 'reviewer', kind: 'data' }],
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
        id: '["coder","reviewer","data"]',
        source: 'coder',
        target: 'reviewer',
        label: undefined,
        // Handles derive from the edge kind + endpoint kinds (both agents
        // here) and are never persisted — fromFlow drops them below.
        sourceHandle: 'source-data-agent',
        targetHandle: 'target-data-agent',
      },
    ]);

    const back = fromFlow({ name: WF.name }, flow.nodes, flow.edges);
    expect(back.nodes).toEqual(WF.nodes);
    expect(back.edges).toEqual([
      { from: 'coder', to: 'reviewer', kind: 'data' },
    ]);
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
      edges: [{ from: 'start', to: 'coder', kind: 'data' }, ...WF.edges],
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
      sourceHandle: 'source-data-agent',
      targetHandle: 'target-data-trigger',
    });
    const back = fromFlow({ name: 'triggered' }, flow.nodes, flow.edges);
    expect(back.nodes[0]).toEqual({
      id: 'start',
      kind: 'trigger',
      trigger: 'manual',
    });
  });

  it('round-trips a call edge, coexisting with a data edge on the same pair', () => {
    const flow = toFlow({
      ...WF,
      edges: [
        { from: 'coder', to: 'reviewer', kind: 'data' },
        { from: 'coder', to: 'reviewer', kind: 'call' },
      ],
    });
    // Per-kind ids keep both edges alive on the canvas; the call edge renders
    // through the `call` edge component and lands on the call handles.
    expect(flow.edges.map((e) => e.id)).toEqual([
      '["coder","reviewer","data"]',
      '["coder","reviewer","call"]',
    ]);
    expect(flow.edges[0]!.type).toBeUndefined();
    expect(flow.edges[1]).toMatchObject({
      type: 'call',
      sourceHandle: 'source-call-agent',
      targetHandle: 'target-call-agent',
    });
    const back = fromFlow({ name: WF.name }, flow.nodes, flow.edges);
    expect(back.edges).toEqual([
      { from: 'coder', to: 'reviewer', kind: 'data' },
      { from: 'coder', to: 'reviewer', kind: 'call' },
    ]);
  });

  it('gives distinct canvas ids to distinct edges even when node ids contain "->"', () => {
    // Node ids from a hand-written YAML file are free-form and may contain
    // '->' themselves; 'a' → 'b->c' and 'a->b' → 'c' are two different wires.
    // React Flow requires unique edge ids — sharing one id breaks rendering
    // and selection of one of the two edges.
    const agent = (id: string) =>
      ({ id, kind: 'agent', agent: 'claude', approval: 'auto' }) as const;
    const flow = toFlow({
      name: 'arrow ids',
      nodes: [agent('a'), agent('b->c'), agent('a->b'), agent('c')],
      edges: [
        { from: 'a', to: 'b->c', kind: 'data' },
        { from: 'a->b', to: 'c', kind: 'data' },
      ],
    });
    expect(new Set(flow.edges.map((e) => e.id)).size).toBe(2);
  });

  it('keeps edge labels when present', () => {
    const flow = toFlow({
      ...WF,
      edges: [{ from: 'coder', to: 'reviewer', kind: 'data', label: 'diff' }],
    });
    const back = fromFlow({ name: 'x' }, flow.nodes, flow.edges);
    expect(back.edges[0]).toEqual({
      from: 'coder',
      to: 'reviewer',
      kind: 'data',
      label: 'diff',
    });
  });
});

describe('canvasSnapshot (the builder dirty-check baseline)', () => {
  it('is stable across a load round-trip and selection, and flips on a real edit', () => {
    const flow = toFlow(WF);
    const baseline = canvasSnapshot('team', '', flow.nodes, flow.edges);

    // Re-serializing the untouched canvas reads clean.
    expect(canvasSnapshot('team', '', flow.nodes, flow.edges)).toBe(baseline);

    // Selecting a node is not an edit — it must never arm the discard guard.
    const selected = flow.nodes.map((n) =>
      n.id === 'coder' ? { ...n, selected: true } : n,
    );
    expect(canvasSnapshot('team', '', selected, flow.edges)).toBe(baseline);

    // Moving a node IS an edit (layout persists to the YAML).
    const moved = flow.nodes.map((n) =>
      n.id === 'coder' ? { ...n, position: { x: 99, y: 20 } } : n,
    );
    expect(canvasSnapshot('team', '', moved, flow.edges)).not.toBe(baseline);

    // Removing an edge IS an edit.
    expect(canvasSnapshot('team', '', flow.nodes, [])).not.toBe(baseline);
  });

  it('normalizes meta like Save does — whitespace and the empty-name fallback', () => {
    const flow = toFlow(WF);
    expect(canvasSnapshot(' team ', '  ', flow.nodes, flow.edges)).toBe(
      canvasSnapshot('team', '', flow.nodes, flow.edges),
    );
    expect(canvasSnapshot('', '', flow.nodes, flow.edges)).toBe(
      canvasSnapshot('workflow', '', flow.nodes, flow.edges),
    );
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
  it('is stable per (endpoint pair, edge kind) — kinds never collide', () => {
    expect(edgeId('a', 'b', 'data')).toBe('["a","b","data"]');
    expect(edgeId('a', 'b', 'call')).toBe('["a","b","call"]');
    expect(edgeId('a', 'b', 'data')).not.toBe(edgeId('a', 'b', 'call'));
  });
});

describe('autoLayout', () => {
  it('positions every node with producers left of consumers', async () => {
    const layout = await autoLayout(WF);
    expect(Object.keys(layout).sort()).toEqual(['coder', 'reviewer']);
    expect(layout.coder!.x).toBeLessThan(layout.reviewer!.x);
  });
});
