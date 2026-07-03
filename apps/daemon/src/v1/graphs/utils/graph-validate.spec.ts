import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';
import { validateWorkflowGraph } from './graph-validate';

function node(id: string): WorkflowNode {
  return { id, agent: 'claude', approval: 'auto' };
}

describe('validateWorkflowGraph', () => {
  // Ported from geniro graph-compiler.spec.ts 'should validate unique node IDs'
  it('rejects duplicate node ids', () => {
    expect(() => validateWorkflowGraph([node('n1'), node('n1')], [])).toThrow(
      BadRequestException,
    );
    try {
      validateWorkflowGraph([node('n1'), node('n1')], []);
    } catch (err) {
      expect((err as BadRequestException).errorCode).toBe(
        'GRAPH_DUPLICATE_NODE',
      );
    }
  });

  // Ported from geniro graph-compiler.spec.ts 'should validate edge references'
  it('rejects an edge referencing a non-existent target', () => {
    const edges: WorkflowEdge[] = [{ from: 'n1', to: 'n2' }];
    expect(() => validateWorkflowGraph([node('n1')], edges)).toThrow(
      BadRequestException,
    );
  });

  it('rejects an edge referencing a non-existent source', () => {
    const edges: WorkflowEdge[] = [{ from: 'ghost', to: 'n1' }];
    expect(() => validateWorkflowGraph([node('n1')], edges)).toThrow(
      BadRequestException,
    );
  });

  it('rejects a self-loop edge', () => {
    const edges: WorkflowEdge[] = [{ from: 'n1', to: 'n1' }];
    expect(() => validateWorkflowGraph([node('n1')], edges)).toThrow(
      BadRequestException,
    );
  });

  it('accepts a valid diamond graph', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
    ];
    expect(() => validateWorkflowGraph(nodes, edges)).not.toThrow();
  });

  it('accepts nodes with no edges', () => {
    expect(() =>
      validateWorkflowGraph([node('n1'), node('n2')], []),
    ).not.toThrow();
  });
});
