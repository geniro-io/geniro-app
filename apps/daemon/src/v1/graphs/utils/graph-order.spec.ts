import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';
import { buildEdgeMaps, computeRunOrder } from './graph-order';

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
