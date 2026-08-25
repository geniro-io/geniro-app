import { describe, expect, it } from 'vitest';

import {
  canConnect,
  connectionEdgeKind,
  flowEdgeKind,
  flowEdgeType,
  makeHandleId,
  NODE_TYPE_SCHEMAS,
} from './node-schema';

describe('canConnect (real registry)', () => {
  it('allows data agent → agent and data trigger → agent', () => {
    expect(canConnect('data', 'agent', 'agent')).toBe(true);
    expect(canConnect('data', 'trigger', 'agent')).toBe(true);
  });

  it('allows call agent → agent but refuses call wires touching triggers', () => {
    expect(canConnect('call', 'agent', 'agent')).toBe(true);
    expect(canConnect('call', 'trigger', 'agent')).toBe(false);
    expect(canConnect('call', 'agent', 'trigger')).toBe(false);
  });

  it('refuses agent → trigger and trigger → trigger (no input rules on trigger)', () => {
    expect(canConnect('data', 'agent', 'trigger')).toBe(false);
    expect(canConnect('data', 'trigger', 'trigger')).toBe(false);
  });

  it('requires BOTH sides — an output rule alone is not enough', () => {
    // sink accepts nothing, yet the source outputs to agents: input side vetoes.
    const rules = {
      agent: { inputs: [], outputs: [{ edge: 'data', kind: 'agent' }] },
    };
    expect(canConnect('data', 'agent', 'agent', rules)).toBe(false);
  });

  it('matches rules by edge kind — a data rule never legalizes a call wire', () => {
    // Both sides list the peer, but only for data edges: a call drag between
    // the same kinds must still refuse.
    const rules = {
      agent: {
        inputs: [{ edge: 'data', kind: 'agent' }],
        outputs: [{ edge: 'data', kind: 'agent' }],
      },
    };
    expect(canConnect('data', 'agent', 'agent', rules)).toBe(true);
    expect(canConnect('call', 'agent', 'agent', rules)).toBe(false);
  });

  it('refuses unknown kinds instead of throwing', () => {
    expect(canConnect('data', 'mystery', 'agent')).toBe(false);
    expect(canConnect('data', 'agent', 'mystery')).toBe(false);
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
      'effort',
      'contextWindow',
      'description',
      'role',
      'approval',
      'configDir',
    ]);
    expect(triggerKeys).toEqual(['id', 'kind', 'name', 'trigger']);
  });
});

describe('connectionEdgeKind', () => {
  it('is a call wire when EITHER end grabbed a call handle', () => {
    expect(connectionEdgeKind('source-call-agent', null)).toBe('call');
    expect(connectionEdgeKind(null, 'target-call-agent')).toBe('call');
    // A call drag dropped on a collapsed node pairs with its top data handle
    // — still a call wire; onConnect normalizes the pair afterwards.
    expect(connectionEdgeKind('source-call-agent', 'target-data-agent')).toBe(
      'call',
    );
  });

  it('defaults to data flow — collapsed drags and missing handles included', () => {
    expect(connectionEdgeKind('source-data-agent', 'target-data-agent')).toBe(
      'data',
    );
    expect(connectionEdgeKind(null, null)).toBe('data');
    expect(connectionEdgeKind(undefined, undefined)).toBe('data');
    // A foreign/legacy scheme ('source-kind-agent') is not a call handle —
    // anything unrecognized must fall back to data flow, never to call.
    expect(connectionEdgeKind('source-kind-agent', 'target-kind-agent')).toBe(
      'data',
    );
  });
});

describe('flowEdgeKind / flowEdgeType', () => {
  it('round-trips the canvas discriminator: type "call" ⇄ kind call, no type ⇄ data', () => {
    expect(flowEdgeKind({ type: 'call' })).toBe('call');
    expect(flowEdgeKind({})).toBe('data');
    // Any third RF edge type is by definition a data edge (documented design).
    expect(flowEdgeKind({ type: 'smoothstep' })).toBe('data');
    expect(flowEdgeType('call')).toEqual({ type: 'call' });
    expect(flowEdgeType('data')).toEqual({});
    // The pair inverts: building an edge then reading it back keeps the kind.
    expect(flowEdgeKind(flowEdgeType('call'))).toBe('call');
    expect(flowEdgeKind(flowEdgeType('data'))).toBe('data');
  });
});

describe('makeHandleId', () => {
  it('derives the per-rule handle id from direction + edge kind + peer kind', () => {
    // Pinned literally: toFlow derives these for STORED edges and the ports
    // block renders Handles under them — a drifted scheme silently detaches
    // every persisted edge from its handle. (Renaming the scheme itself is
    // safe: handle ids are derived on load, never persisted in the YAML.)
    expect(makeHandleId('target', 'data', 'trigger')).toBe(
      'target-data-trigger',
    );
    expect(makeHandleId('target', 'data', 'agent')).toBe('target-data-agent');
    expect(makeHandleId('source', 'data', 'agent')).toBe('source-data-agent');
    expect(makeHandleId('source', 'call', 'agent')).toBe('source-call-agent');
    expect(makeHandleId('target', 'call', 'agent')).toBe('target-call-agent');
  });
});

describe('instruction wiring (real registry)', () => {
  it('allows an instruction edge block → agent and nothing else', () => {
    expect(canConnect('instruction', 'instruction', 'agent')).toBe(true);
    expect(canConnect('instruction', 'instruction', 'trigger')).toBe(false);
    expect(canConnect('instruction', 'agent', 'agent')).toBe(false);
    // A block produces no output to order and runs nothing to be called.
    expect(canConnect('data', 'instruction', 'agent')).toBe(false);
    expect(canConnect('call', 'agent', 'instruction')).toBe(false);
  });

  it('carries its own React Flow type, distinct from data and call', () => {
    expect(flowEdgeType('instruction')).toEqual({ type: 'instruction' });
    expect(flowEdgeKind({ type: 'instruction' })).toBe('instruction');
    // An unknown type is data flow, which is what keeps "no type" honest.
    expect(flowEdgeKind({ type: 'mystery' })).toBe('data');
  });

  it('reads an instruction drag off either handle', () => {
    expect(
      connectionEdgeKind(
        makeHandleId('source', 'instruction', 'agent'),
        undefined,
      ),
    ).toBe('instruction');
    expect(
      connectionEdgeKind(
        undefined,
        makeHandleId('target', 'instruction', 'instruction'),
      ),
    ).toBe('instruction');
    // A collapsed drag with no handle ids stays data flow.
    expect(connectionEdgeKind(undefined, undefined)).toBe('data');
  });

  it('describes the block’s one editable field', () => {
    expect(NODE_TYPE_SCHEMAS.instruction.map((f) => f.key)).toContain(
      'instructions',
    );
  });
});

describe('connectionEdgeKind resolves from the SOURCE end', () => {
  // The two ends can name different annotation kinds — an instruction block's
  // only output dropped onto an agent's expanded `call` row. Answering with
  // the target's kind yields a wire `canConnect` refuses, so the drop does
  // nothing and the user is told nothing.
  it('answers instruction for a block’s output dropped on a call row', () => {
    const kind = connectionEdgeKind(
      makeHandleId('source', 'instruction', 'agent'),
      makeHandleId('target', 'call', 'agent'),
    );
    expect(kind).toBe('instruction');
    expect(canConnect(kind, 'instruction', 'agent')).toBe(true);
  });

  it('still reads a call drag whose other end is a collapsed data handle', () => {
    expect(
      connectionEdgeKind(
        makeHandleId('source', 'data', 'agent'),
        makeHandleId('target', 'call', 'agent'),
      ),
    ).toBe('call');
  });
});
