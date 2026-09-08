import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';
import {
  buildEdgeMaps,
  computeRunOrder,
  isNonExecutableNode,
  onDemandNodeIds,
  terminalNodeIds,
} from './graph-order';

function node(id: string): WorkflowNode {
  return { id, kind: 'agent', agent: 'claude', approval: 'auto' };
}

function data(from: string, to: string): WorkflowEdge {
  return { from, to, kind: 'data' };
}

function call(from: string, to: string): WorkflowEdge {
  return { from, to, kind: 'call' };
}

describe('computeRunOrder', () => {
  // Ported from geniro graph-compiler.spec.ts 'should build nodes in correct
  // dependency order' — same chain, expressed in geniro-app's producer→consumer
  // edge direction (rt feeds tool feeds agent).
  it('orders a linear chain producers-first', () => {
    const nodes = [node('agent'), node('tool'), node('rt')];
    const edges = [data('rt', 'tool'), data('tool', 'agent')];
    const order = computeRunOrder(nodes, edges).map((n) => n.id);
    expect(order).toEqual(['rt', 'tool', 'agent']);
  });

  // Ported from geniro graph-compiler.spec.ts 'should handle graph without edges'
  it('includes every node when there are no edges', () => {
    const order = computeRunOrder([node('n1'), node('n2')], []);
    expect(order.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('orders a diamond with the join last', () => {
    const nodes = [node('d'), node('b'), node('c'), node('a')];
    const edges = [
      data('a', 'b'),
      data('a', 'c'),
      data('b', 'd'),
      data('c', 'd'),
    ];
    const order = computeRunOrder(nodes, edges).map((n) => n.id);
    expect(order[0]).toBe('a');
    expect(order[3]).toBe('d');
    expect(order.slice(1, 3).sort()).toEqual(['b', 'c']);
  });

  it('throws GRAPH_CIRCULAR_DEPENDENCY naming the cycle nodes', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [data('a', 'b'), data('b', 'c'), data('c', 'b')];
    try {
      computeRunOrder(nodes, edges);
      expect.unreachable('expected a cycle rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const exception = err as BadRequestException;
      expect(exception.errorCode).toBe('GRAPH_CIRCULAR_DEPENDENCY');
      expect(exception.getMessage()).toContain('b');
      expect(exception.getMessage()).toContain('c');
    }
  });

  it('ignores call edges: a call cycle is NOT a topological cycle', () => {
    // a and b call each other — legal wiring; only data edges order the run.
    const nodes = [node('a'), node('b')];
    const edges = [data('a', 'b'), call('b', 'a'), call('a', 'b')];
    const order = computeRunOrder(nodes, edges).map((n) => n.id);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('buildEdgeMaps', () => {
  it('maps producers and consumers per node', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [data('a', 'c'), data('b', 'c')];
    const { producersOf, consumersOf } = buildEdgeMaps(nodes, edges);
    expect([...producersOf.get('c')!].sort()).toEqual(['a', 'b']);
    expect(producersOf.get('a')!.size).toBe(0);
    expect([...consumersOf.get('a')!]).toEqual(['c']);
    expect([...consumersOf.get('b')!]).toEqual(['c']);
    expect(consumersOf.get('c')!.size).toBe(0);
  });

  it('excludes call edges from the adjacency — they grant a tool, not data', () => {
    // A call-only callee has NO producers: it must never be scheduled as a
    // root or waited on by the DAG walk (it runs on demand in milestone 2).
    const nodes = [node('a'), node('callee')];
    const { producersOf, consumersOf } = buildEdgeMaps(nodes, [
      call('a', 'callee'),
    ]);
    expect(producersOf.get('callee')!.size).toBe(0);
    expect(consumersOf.get('a')!.size).toBe(0);
  });
});

describe('onDemandNodeIds', () => {
  it('marks call targets with no data input as on-demand', () => {
    const nodes = [node('orch'), node('helper')];
    expect(onDemandNodeIds(nodes, [call('orch', 'helper')])).toEqual(
      new Set(['helper']),
    );
  });

  it('a call target that ALSO has a data producer runs as a normal DAG node', () => {
    const nodes = [node('t'), node('orch'), node('helper')];
    const edges = [data('t', 'helper'), call('orch', 'helper')];
    expect(onDemandNodeIds(nodes, edges).size).toBe(0);
  });

  it('nodes without call edges are never on-demand', () => {
    const nodes = [node('a'), node('b')];
    expect(onDemandNodeIds(nodes, [data('a', 'b')]).size).toBe(0);
  });
});

function instructionBlock(id: string): WorkflowNode {
  return { id, kind: 'instruction', instructions: 'Be terse.' };
}

function instructionEdge(from: string, to: string): WorkflowEdge {
  return { from, to, kind: 'instruction' };
}

describe('onDemandNodeIds and instruction edges', () => {
  // An instruction edge feeds no prompt, so it must not count as a data input:
  // treating it as one makes a call-only callee look DAG-scheduled, and the
  // walk then waits on a node it never launches.
  it('leaves a call-only callee on demand when an instruction block is wired to it', () => {
    const nodes = [
      node('caller'),
      node('callee'),
      instructionBlock('house-style'),
    ];
    const edges = [
      call('caller', 'callee'),
      instructionEdge('house-style', 'callee'),
    ];
    expect([...onDemandNodeIds(nodes, edges)]).toEqual(['callee']);
  });

  it('still takes a real data input off the on-demand set', () => {
    const nodes = [node('caller'), node('callee'), node('feeder')];
    const edges = [call('caller', 'callee'), data('feeder', 'callee')];
    expect([...onDemandNodeIds(nodes, edges)]).toEqual([]);
  });
});

describe('isNonExecutableNode', () => {
  it('is true for an instruction block and false for the kinds that run', () => {
    expect(isNonExecutableNode(instructionBlock('note'))).toBe(true);
    expect(isNonExecutableNode(node('a'))).toBe(false);
    expect(isNonExecutableNode({ kind: 'trigger' })).toBe(false);
  });
});

describe('terminalNodeIds', () => {
  it('is the node a fan-out collects into, not every leaf that wrote late', () => {
    const nodes = ['plan', 'a', 'b', 'sum'].map(node);
    const edges = [
      data('plan', 'a'),
      data('plan', 'b'),
      data('a', 'sum'),
      data('b', 'sum'),
    ];
    expect([...terminalNodeIds(nodes, edges)]).toEqual(['sum']);
  });

  // A call edge grants a tool and orders nothing (`buildEdgeMaps`' own rule),
  // so a node that answers callers and feeds no consumer is still where the
  // walk finishes — counting call edges would leave a run with no conclusion.
  it('is unaffected by a call edge leaving the node', () => {
    const nodes = [node('worker'), node('helper')];
    const edges = [call('worker', 'helper'), data('helper', 'worker')];
    expect([...terminalNodeIds(nodes, edges)]).toEqual(['worker']);
  });

  it('excludes an on-demand callee, whose output answers its caller', () => {
    // Called and fed by nothing: it produces one answer per call rather than
    // the run's conclusion, however late the last of them arrives.
    const nodes = [node('driver'), node('oracle')];
    const edges = [call('driver', 'oracle')];
    expect([...terminalNodeIds(nodes, edges)]).toEqual(['driver']);
  });

  it('excludes an instruction block, which never runs at all', () => {
    const nodes = [node('writer'), instructionBlock('style')];
    const edges = [instructionEdge('style', 'writer')];
    expect([...terminalNodeIds(nodes, edges)]).toEqual(['writer']);
  });

  it('is empty when nothing qualifies, rather than naming a node that never ran', () => {
    // The caller reads empty as "no opinion" and falls back to the whole
    // transcript — naming a block here would file a report on a node with no
    // transcript rows of its own, which is a card with no report at all.
    expect([...terminalNodeIds([instructionBlock('style')], [])]).toEqual([]);
  });
});

describe('computeRunOrder with instruction blocks', () => {
  // An instruction edge orders nothing, so a block wired to an agent must not
  // become one of that agent's producers — the agent stays a root and the
  // trigger-fed chain keeps its shape.
  it('does not make an instruction block a producer of its target', () => {
    const nodes = [node('writer'), instructionBlock('style')];
    const edges = [instructionEdge('style', 'writer')];
    const { producersOf } = buildEdgeMaps(nodes, edges);
    expect([...(producersOf.get('writer') ?? [])]).toEqual([]);
    expect(
      computeRunOrder(nodes, edges)
        .map((n) => n.id)
        .sort(),
    ).toEqual(['style', 'writer']);
  });
});
