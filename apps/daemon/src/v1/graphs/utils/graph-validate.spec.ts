import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { WorkflowEdge, WorkflowNode } from '../graphs.types';
import {
  validateEdgeRules,
  validateRunnableGraph,
  validateWorkflowGraph,
} from './graph-validate';

function node(id: string): WorkflowNode {
  return { id, kind: 'agent', agent: 'claude', approval: 'auto' };
}

function trigger(id: string): WorkflowNode {
  return { id, kind: 'trigger', trigger: 'manual' };
}

function errorCode(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as BadRequestException).errorCode;
  }
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

describe('connection rules under the REAL registry (via validateWorkflowGraph)', () => {
  it('accepts trigger → agent and rejects agent → trigger', () => {
    expect(() =>
      validateWorkflowGraph(
        [trigger('t'), node('a')],
        [{ from: 't', to: 'a' }],
      ),
    ).not.toThrow();

    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [node('a'), trigger('t')],
          [{ from: 'a', to: 't' }],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('rejects a trigger feeding a trigger', () => {
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [trigger('t1'), trigger('t2')],
          [{ from: 't1', to: 't2' }],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('allows at most ONE trigger into an agent (single-arity input rule)', () => {
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [trigger('t1'), trigger('t2'), node('a')],
          [
            { from: 't1', to: 'a' },
            { from: 't2', to: 'a' },
          ],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('lets one trigger fan out to several agents', () => {
    expect(() =>
      validateWorkflowGraph(
        [trigger('t'), node('a'), node('b')],
        [
          { from: 't', to: 'a' },
          { from: 't', to: 'b' },
        ],
      ),
    ).not.toThrow();
  });
});

describe('validateRunnableGraph', () => {
  it('rejects an empty workflow', () => {
    expect(errorCode(() => validateRunnableGraph([], []))).toBe('GRAPH_EMPTY');
  });

  it('rejects a workflow with no trigger', () => {
    expect(
      errorCode(() =>
        validateRunnableGraph([node('a'), node('b')], [{ from: 'a', to: 'b' }]),
      ),
    ).toBe('GRAPH_NO_TRIGGER');
  });

  it('rejects an agent not connected downstream of a trigger', () => {
    // t → a is fine, but `stray` is a root that is not a trigger.
    expect(
      errorCode(() =>
        validateRunnableGraph(
          [trigger('t'), node('a'), node('stray')],
          [{ from: 't', to: 'a' }],
        ),
      ),
    ).toBe('GRAPH_UNTRIGGERED_NODE');
  });

  it('accepts a trigger-rooted graph', () => {
    expect(() =>
      validateRunnableGraph(
        [trigger('t'), node('a'), node('b')],
        [
          { from: 't', to: 'a' },
          { from: 'a', to: 'b' },
        ],
      ),
    ).not.toThrow();
  });
});

describe('validateEdgeRules', () => {
  // A hypothetical registry distinct from the real one (its trigger fires at
  // most ONE agent, and agent → trigger has no rule on either side) so each
  // refusal branch is entered deliberately, not incidentally.
  const RULES = {
    agent: {
      inputs: [
        { kind: 'agent', multiple: true },
        { kind: 'trigger', multiple: true },
      ],
      outputs: [{ kind: 'agent', multiple: true }],
    },
    trigger: {
      inputs: [],
      outputs: [{ kind: 'agent' }], // no `multiple` — single edge only
    },
  };
  const n = (id: string, kind: string): { id: string; kind: string } => ({
    id,
    kind,
  });

  it('rejects an edge with no matching rule pair (agent → trigger)', () => {
    // agent lists no trigger output AND trigger has no inputs at all.
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('a', 'agent'), n('t', 'trigger')],
          [{ from: 'a', to: 't' }],
          RULES,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('requires BOTH sides to agree — an output rule alone is not enough', () => {
    // sink accepts nothing, yet agent outputs to agents: the input side vetoes.
    const rules = {
      agent: { inputs: [], outputs: [{ kind: 'agent', multiple: true }] },
    };
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('a', 'agent'), n('b', 'agent')],
          [{ from: 'a', to: 'b' }],
          rules,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('accepts a legal trigger → agent edge', () => {
    expect(() =>
      validateEdgeRules(
        [n('t', 'trigger'), n('a', 'agent')],
        [{ from: 't', to: 'a' }],
        RULES,
      ),
    ).not.toThrow();
  });

  it('enforces single-edge rules (trigger may fire only one agent)', () => {
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('t', 'trigger'), n('a', 'agent'), n('b', 'agent')],
          [
            { from: 't', to: 'a' },
            { from: 't', to: 'b' },
          ],
          RULES,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('enforces required input rules', () => {
    const rules = {
      agent: {
        inputs: [{ kind: 'trigger', required: true }],
        outputs: [],
      },
      trigger: { inputs: [], outputs: [{ kind: 'agent' }] },
    };
    expect(
      errorCode(() => validateEdgeRules([n('a', 'agent')], [], rules)),
    ).toBe('GRAPH_REQUIRED_INPUT');
    expect(() =>
      validateEdgeRules(
        [n('t', 'trigger'), n('a', 'agent')],
        [{ from: 't', to: 'a' }],
        rules,
      ),
    ).not.toThrow();
  });

  it('rejects a node kind missing from the registry', () => {
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('x', 'mystery'), n('a', 'agent')],
          [{ from: 'x', to: 'a' }],
          RULES,
        ),
      ),
    ).toBe('GRAPH_UNKNOWN_NODE_KIND');
  });

  it('passes every agent → agent fan-out under the REAL registry (via validateWorkflowGraph)', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges: WorkflowEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ];
    expect(() => validateWorkflowGraph(nodes, edges)).not.toThrow();
  });
});
