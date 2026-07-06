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

function data(from: string, to: string): WorkflowEdge {
  return { from, to, kind: 'data' };
}

function call(from: string, to: string): WorkflowEdge {
  return { from, to, kind: 'call' };
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
    expect(() =>
      validateWorkflowGraph([node('n1')], [data('n1', 'n2')]),
    ).toThrow(BadRequestException);
  });

  it('rejects an edge referencing a non-existent source', () => {
    expect(() =>
      validateWorkflowGraph([node('n1')], [data('ghost', 'n1')]),
    ).toThrow(BadRequestException);
  });

  it('rejects a self-loop edge of either kind', () => {
    expect(() =>
      validateWorkflowGraph([node('n1')], [data('n1', 'n1')]),
    ).toThrow(BadRequestException);
    expect(() =>
      validateWorkflowGraph([node('n1')], [call('n1', 'n1')]),
    ).toThrow(BadRequestException);
  });

  it('accepts a valid diamond graph', () => {
    const nodes = [node('a'), node('b'), node('c'), node('d')];
    const edges = [
      data('a', 'b'),
      data('a', 'c'),
      data('b', 'd'),
      data('c', 'd'),
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
      validateWorkflowGraph([trigger('t'), node('a')], [data('t', 'a')]),
    ).not.toThrow();

    expect(
      errorCode(() =>
        validateWorkflowGraph([node('a'), trigger('t')], [data('a', 't')]),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('rejects a trigger feeding a trigger', () => {
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [trigger('t1'), trigger('t2')],
          [data('t1', 't2')],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('allows at most ONE trigger into an agent (single-arity input rule)', () => {
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [trigger('t1'), trigger('t2'), node('a')],
          [data('t1', 'a'), data('t2', 'a')],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('lets one trigger fan out to several agents', () => {
    expect(() =>
      validateWorkflowGraph(
        [trigger('t'), node('a'), node('b')],
        [data('t', 'a'), data('t', 'b')],
      ),
    ).not.toThrow();
  });

  it('accepts agent → agent call edges, rejects call wires touching triggers', () => {
    expect(() =>
      validateWorkflowGraph([node('a'), node('b')], [call('a', 'b')]),
    ).not.toThrow();

    expect(
      errorCode(() =>
        validateWorkflowGraph([trigger('t'), node('a')], [call('t', 'a')]),
      ),
    ).toBe('GRAPH_EDGE_RULE');
    expect(
      errorCode(() =>
        validateWorkflowGraph([node('a'), trigger('t')], [call('a', 't')]),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('lets a data edge and a call edge share the same ordered pair', () => {
    // Separate identities: the duplicate-wire check keys on (from, to, edge
    // kind), so the two kinds may coexist on one pair — a kind-less duplicate
    // key would reject the second wire here.
    expect(() =>
      validateWorkflowGraph(
        [node('a'), node('b')],
        [data('a', 'b'), call('a', 'b')],
      ),
    ).not.toThrow();
  });

  it('rejects a duplicate wire of the same kind on one ordered pair', () => {
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [node('a'), node('b')],
          [call('a', 'b'), call('a', 'b')],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
    expect(
      errorCode(() =>
        validateWorkflowGraph(
          [node('a'), node('b')],
          [data('a', 'b'), data('a', 'b')],
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('keeps two distinct edges apart when node ids themselves contain " -> "', () => {
    // Node ids are free-form strings (zod min(1)) — a hand-written file may
    // name nodes 'a -> b' or 'b -> c'. The wires 'a' → 'b -> c' and
    // 'a -> b' → 'c' are DIFFERENT edges; a delimiter-joined duplicate key
    // must not merge them into one false "duplicate edge" rejection.
    expect(() =>
      validateWorkflowGraph(
        [node('a'), node('b -> c'), node('a -> b'), node('c')],
        [data('a', 'b -> c'), data('a -> b', 'c')],
      ),
    ).not.toThrow();
  });

  it('allows mutual call edges (a calls b, b calls a) — call cycles are legal', () => {
    expect(() =>
      validateWorkflowGraph(
        [node('a'), node('b')],
        [call('a', 'b'), call('b', 'a')],
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
        validateRunnableGraph([node('a'), node('b')], [data('a', 'b')]),
      ),
    ).toBe('GRAPH_NO_TRIGGER');
  });

  it('rejects an agent with no incoming edge at all', () => {
    // t → a is fine, but `stray` is a root that is not a trigger.
    expect(
      errorCode(() =>
        validateRunnableGraph(
          [trigger('t'), node('a'), node('stray')],
          [data('t', 'a')],
        ),
      ),
    ).toBe('GRAPH_UNTRIGGERED_NODE');
  });

  it('accepts a call-only node — an incoming call edge legalizes it', () => {
    // The callee has no trigger path; it is invoked on demand at runtime.
    expect(() =>
      validateRunnableGraph(
        [trigger('t'), node('a'), node('callee')],
        [data('t', 'a'), call('a', 'callee')],
      ),
    ).not.toThrow();
  });

  it('accepts a trigger-rooted graph', () => {
    expect(() =>
      validateRunnableGraph(
        [trigger('t'), node('a'), node('b')],
        [data('t', 'a'), data('a', 'b')],
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
        { edge: 'data', kind: 'agent', multiple: true },
        { edge: 'data', kind: 'trigger', multiple: true },
      ],
      outputs: [{ edge: 'data', kind: 'agent', multiple: true }],
    },
    trigger: {
      inputs: [],
      outputs: [{ edge: 'data', kind: 'agent' }], // no `multiple` — single edge only
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
          [data('a', 't')],
          RULES,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('requires BOTH sides to agree — an output rule alone is not enough', () => {
    // sink accepts nothing, yet agent outputs to agents: the input side vetoes.
    const rules = {
      agent: {
        inputs: [],
        outputs: [{ edge: 'data', kind: 'agent', multiple: true }],
      },
    };
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('a', 'agent'), n('b', 'agent')],
          [data('a', 'b')],
          rules,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('matches rules by edge kind — a data-only registry refuses a call wire', () => {
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('a', 'agent'), n('b', 'agent')],
          [call('a', 'b')],
          RULES,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('accepts a legal trigger → agent edge', () => {
    expect(() =>
      validateEdgeRules(
        [n('t', 'trigger'), n('a', 'agent')],
        [data('t', 'a')],
        RULES,
      ),
    ).not.toThrow();
  });

  it('enforces single-edge rules (trigger may fire only one agent)', () => {
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('t', 'trigger'), n('a', 'agent'), n('b', 'agent')],
          [data('t', 'a'), data('t', 'b')],
          RULES,
        ),
      ),
    ).toBe('GRAPH_EDGE_RULE');
  });

  it('counts arity per edge kind — a call wire never consumes a data bucket', () => {
    // BOTH input rules are single-arity, so both edges genuinely enter the
    // count buckets: one data + one call wire from the SAME peer is legal
    // only while the buckets are (edge kind, peer kind) scoped — collapse
    // the keys to peer kind alone and the second wire trips the data rule's
    // single arity, failing this test. (A `multiple` call rule here would
    // never bump a bucket at all, leaving the bucket keys unpinned.)
    const rules = {
      agent: {
        inputs: [
          { edge: 'data', kind: 'agent' }, // single
          { edge: 'call', kind: 'agent' }, // single
        ],
        outputs: [
          { edge: 'data', kind: 'agent', multiple: true },
          { edge: 'call', kind: 'agent', multiple: true },
        ],
      },
    };
    expect(() =>
      validateEdgeRules(
        [n('a', 'agent'), n('b', 'agent')],
        [data('a', 'b'), call('a', 'b')],
        rules,
      ),
    ).not.toThrow();
  });

  it('enforces required input rules per edge kind', () => {
    const rules = {
      agent: {
        inputs: [{ edge: 'data', kind: 'trigger', required: true }],
        outputs: [],
      },
      trigger: { inputs: [], outputs: [{ edge: 'data', kind: 'agent' }] },
    };
    expect(
      errorCode(() => validateEdgeRules([n('a', 'agent')], [], rules)),
    ).toBe('GRAPH_REQUIRED_INPUT');
    expect(() =>
      validateEdgeRules(
        [n('t', 'trigger'), n('a', 'agent')],
        [data('t', 'a')],
        rules,
      ),
    ).not.toThrow();
  });

  it('rejects a node kind missing from the registry', () => {
    expect(
      errorCode(() =>
        validateEdgeRules(
          [n('x', 'mystery'), n('a', 'agent')],
          [data('x', 'a')],
          RULES,
        ),
      ),
    ).toBe('GRAPH_UNKNOWN_NODE_KIND');
  });

  it('passes every agent → agent fan-out under the REAL registry (via validateWorkflowGraph)', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const edges = [data('a', 'b'), data('a', 'c'), data('b', 'c')];
    expect(() => validateWorkflowGraph(nodes, edges)).not.toThrow();
  });
});
