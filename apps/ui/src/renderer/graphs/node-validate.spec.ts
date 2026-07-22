import { describe, expect, it } from 'vitest';

import type { CliKind, WorkflowNode } from '../../shared/contracts';
import {
  agentCallInfo,
  callCycleNodeIds,
  type CanvasEdge,
  validateNode,
} from './node-validate';

const trigger: WorkflowNode = { id: 't1', kind: 'trigger', trigger: 'manual' };
const trigger2: WorkflowNode = {
  id: 't2',
  kind: 'trigger',
  trigger: 'manual',
};
const agentA: WorkflowNode = {
  id: 'a1',
  kind: 'agent',
  agent: 'claude',
  approval: 'auto',
};

const KINDS: Record<string, string> = {
  t1: 'trigger',
  t2: 'trigger',
  a1: 'agent',
  a2: 'agent',
  a3: 'agent',
};

// Canvas edges as React Flow carries them: data edges have no `type`, call
// edges render through the `call` edge type (same discriminator fromFlow uses).
function edge(source: string, target: string): CanvasEdge {
  return { source, target };
}

function call(source: string, target: string): CanvasEdge {
  return { source, target, type: 'call' };
}

describe('validateNode', () => {
  it('accepts every node of a properly triggered fan-out graph', () => {
    // trigger → a1 → {a2, a3}: multiple agent outputs/inputs are legal.
    const edges = [edge('t1', 'a1'), edge('a1', 'a2'), edge('a1', 'a3')];
    for (const node of [
      trigger,
      agentA,
      { ...agentA, id: 'a2' },
      { ...agentA, id: 'a3' },
    ]) {
      expect(validateNode(node, KINDS, edges)).toEqual([]);
    }
  });

  it('flags an agent nothing feeds — a run could never reach it', () => {
    expect(validateNode(agentA, KINDS, [])).toEqual([
      {
        type: 'connection',
        side: 'input',
        message:
          'No input connected — wire a trigger, an upstream agent, or a call edge into this node.',
      },
    ]);
  });

  it('accepts a call-only callee — an incoming call edge makes it reachable', () => {
    // Mirrors the daemon's GRAPH_UNTRIGGERED_NODE: a node that is only ever
    // invoked via call_agent needs no trigger/data input.
    expect(validateNode(agentA, KINDS, [call('a2', 'a1')])).toEqual([]);
  });

  it('an outgoing call edge does NOT make the CALLER reachable', () => {
    // The caller still needs its own trigger/data input — only an INCOMING
    // edge (of any kind) satisfies reachability.
    const caller = { ...agentA, id: 'a2' };
    expect(
      validateNode(caller, KINDS, [call('a2', 'a1')]).map((e) => e.message),
    ).toEqual([
      'No input connected — wire a trigger, an upstream agent, or a call edge into this node.',
    ]);
  });

  it("flags a call-only node feeding a data edge (mirror of the daemon's GRAPH_CALL_ONLY_PRODUCER)", () => {
    // a2 --call--> a1 --data--> a3: a1 runs on demand, so its output has no
    // place in the DAG order — this stayed green in the builder and only
    // failed at POST /:slug/runs before the mirror landed.
    const edges = [call('a2', 'a1'), edge('a1', 'a3')];
    expect(validateNode(agentA, KINDS, edges).map((e) => e.message)).toEqual([
      'This node is call-only (runs on demand) — its output cannot feed a data edge. Wire a data input into it or remove that edge.',
    ]);
  });

  it('a callee with a data input may feed data (it also runs as a DAG node)', () => {
    const edges = [edge('t1', 'a1'), call('a2', 'a1'), edge('a1', 'a3')];
    expect(validateNode(agentA, KINDS, edges)).toEqual([]);
  });

  it('a call-only node with an outgoing CALL edge stays clean (calls are not data flow)', () => {
    const edges = [call('a2', 'a1'), call('a1', 'a3')];
    expect(validateNode(agentA, KINDS, edges)).toEqual([]);
  });

  it('flags call edges touching a trigger on both endpoints', () => {
    expect(
      validateNode(trigger, KINDS, [call('a1', 't1')]).map((e) => e.message),
    ).toContain("A node of kind 'agent' cannot call this trigger node.");
    expect(
      validateNode(trigger, KINDS, [call('t1', 'a1')]).map((e) => e.message),
    ).toContain("This trigger node cannot call a node of kind 'agent'.");
  });

  it('buckets arity per edge kind — call edges never eat a data rule', () => {
    // One trigger + one upstream agent + one incoming call: all three land in
    // their own (edge kind, peer kind) buckets, so nothing trips the
    // single-trigger arity and the node is clean.
    const edges = [edge('t1', 'a1'), edge('a2', 'a1'), call('a3', 'a1')];
    expect(validateNode(agentA, KINDS, edges)).toEqual([]);
  });

  it('flags a trigger with nothing to fire', () => {
    expect(validateNode(trigger, KINDS, [])).toEqual([
      {
        type: 'connection',
        side: 'output',
        message: 'This trigger fires nothing — connect it to an agent.',
      },
    ]);
  });

  it('flags an illegal trigger→trigger edge on both endpoints', () => {
    const edges = [edge('t1', 't2')];
    expect(validateNode(trigger, KINDS, edges).map((e) => e.message)).toContain(
      "This trigger node cannot feed a node of kind 'trigger'.",
    );
    expect(
      validateNode(trigger2, KINDS, edges).map((e) => e.message),
    ).toContain("A node of kind 'trigger' cannot feed this trigger node.");
  });

  it('flags two triggers feeding one agent (single-arity input rule)', () => {
    const edges = [edge('t1', 'a1'), edge('t2', 'a1')];
    expect(validateNode(agentA, KINDS, edges)).toEqual([
      {
        type: 'connection',
        side: 'input',
        message: 'Only one trigger may feed this node (got 2).',
      },
    ]);
  });

  it('flags a missing required config field', () => {
    const broken: WorkflowNode = {
      id: 'a1',
      kind: 'agent',
      agent: '' as CliKind,
      approval: 'auto',
    };
    // Fed by a trigger so the connection side stays clean — the config error
    // must stand on its own.
    expect(validateNode(broken, KINDS, [edge('t1', 'a1')])).toEqual([
      { type: 'config', message: "Missing required field 'agent'." },
    ]);
  });

  it('reports an unknown node kind instead of throwing', () => {
    // An older daemon (or a hand-written file) can hand the renderer a node
    // whose kind the registries don't know — the card must degrade to its
    // red state, never crash the canvas.
    const legacy = { id: 'x1', agent: 'claude' } as unknown as WorkflowNode;
    expect(validateNode(legacy, KINDS, [])).toEqual([
      {
        type: 'config',
        message:
          "Unknown node kind 'undefined' — this app version does not support it.",
      },
    ]);
  });

  it('ignores dangling edges whose peer is not on the canvas', () => {
    // The ghost edge neither satisfies the input requirement nor produces an
    // illegal-kind error — it is skipped entirely.
    expect(
      validateNode(agentA, KINDS, [edge('ghost', 'a1')]).map((e) => e.message),
    ).toEqual([
      'No input connected — wire a trigger, an upstream agent, or a call edge into this node.',
    ]);
  });
});

describe('callCycleNodeIds', () => {
  it('reports every node on a call loop (mutual and longer chains)', () => {
    expect(callCycleNodeIds([call('a1', 'a2'), call('a2', 'a1')])).toEqual(
      new Set(['a1', 'a2']),
    );
    expect(
      callCycleNodeIds([call('a1', 'a2'), call('a2', 'a3'), call('a3', 'a1')]),
    ).toEqual(new Set(['a1', 'a2', 'a3']));
  });

  it('flags a self-call loop', () => {
    // The canvas refuses self-loops, but a hand-edited YAML reaches this
    // helper unvalidated (store.get parses without graph validation).
    expect(callCycleNodeIds([call('a1', 'a1')])).toEqual(new Set(['a1']));
  });

  it('reports nothing for acyclic calls or data-only cycles', () => {
    expect(callCycleNodeIds([call('a1', 'a2'), call('a1', 'a3')])).toEqual(
      new Set(),
    );
    // A data cycle is the topo-sort's problem, never a call-loop lint.
    expect(callCycleNodeIds([edge('a1', 'a2'), edge('a2', 'a1')])).toEqual(
      new Set(),
    );
  });
});

describe('agentCallInfo', () => {
  const nodes = [
    { id: 'a1', name: 'Orchestrator' },
    { id: 'a2' },
    { id: 'a3', name: 'Helper' },
  ];

  it('is null while no call edge touches the node — data wiring never shows the section', () => {
    expect(agentCallInfo('a1', nodes, [edge('a1', 'a2')])).toBeNull();
    expect(agentCallInfo('a1', nodes, [])).toBeNull();
  });

  it('lists callees and callers by display name (id when unnamed)', () => {
    const edges = [
      edge('t1', 'a1'),
      call('a1', 'a2'),
      call('a1', 'a3'),
      call('a3', 'a1'),
    ];
    expect(agentCallInfo('a1', nodes, edges)).toEqual({
      callees: ['a2', 'Helper'],
      callers: ['Helper'],
      inCycle: true, // a1 → a3 → a1 closes a call loop
    });
    // a2 is a pure callee: callable, calls no one, on no loop.
    expect(agentCallInfo('a2', nodes, edges)).toEqual({
      callees: [],
      callers: ['Orchestrator'],
      inCycle: false,
    });
  });
});
