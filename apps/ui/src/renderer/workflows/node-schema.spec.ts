import { describe, expect, it } from 'vitest';

import {
  arityAllowsConnection,
  canConnect,
  connectionArity,
  connectionEdgeKind,
  flowEdgeKind,
  flowEdgeType,
  makeHandleId,
  NODE_TYPE_SCHEMAS,
} from './node-schema';

describe('connectionArity (real registry)', () => {
  it('holds a trigger to ONE agent, at both ends of the wire', () => {
    // The breaking change this shipped with: a trigger starts exactly one
    // agent. Both ends are single here — the agent's own trigger input has
    // always been — so the canvas refuses a second wire whichever end the user
    // drags from.
    expect(connectionArity('data', 'trigger', 'agent')).toEqual({
      manyFromSource: false,
      manyIntoTarget: false,
    });
  });

  it('still lets an agent fan out to several agents', () => {
    // The control, and the reason this is not simply "everything is single":
    // an agent's data output and its call output are both many, so a predicate
    // that refused a second wire everywhere would break the DAG this app is
    // for.
    expect(connectionArity('data', 'agent', 'agent')).toMatchObject({
      manyFromSource: true,
    });
    expect(connectionArity('call', 'agent', 'agent')).toMatchObject({
      manyFromSource: true,
    });
  });

  it('answers single for a pair the rules do not describe', () => {
    // An unknown kind refuses rather than throwing, matching `canConnect`'s
    // stance for a live drag predicate — and it must not answer `true`, which
    // would permit an unlimited number of a wire nothing has a rule for.
    expect(connectionArity('data', 'nonesuch', 'agent')).toEqual({
      manyFromSource: false,
      manyIntoTarget: false,
    });
  });
});

describe('arityAllowsConnection (real registry)', () => {
  // A tiny canvas: one trigger, three agents. `kindOf` is what the builder
  // supplies from its node list; the edges are React Flow's own shape, whose
  // ABSENT `type` reads as `data` — which is how every edge drawn before the
  // annotation kinds existed still counts.
  const kindOf = (id: string): string | undefined =>
    ({ t1: 'trigger', a1: 'agent', a2: 'agent', a3: 'agent' })[id];

  it('lets the FIRST wire out of a trigger through, and refuses the second', () => {
    // The breaking change this shipped with, from the end the user drags from.
    expect(
      arityAllowsConnection(
        'data',
        { source: 't1', target: 'a1' },
        {
          kindOf,
          edges: [],
        },
      ),
    ).toBe(true);
    expect(
      arityAllowsConnection(
        'data',
        { source: 't1', target: 'a2' },
        {
          kindOf,
          edges: [{ source: 't1', target: 'a1' }],
        },
      ),
    ).toBe(false);
  });

  it('refuses a SECOND trigger into an agent that already has one', () => {
    // The other end, which was single-arity long before this change and drew
    // fine anyway — the canvas simply never counted.
    expect(
      arityAllowsConnection(
        'data',
        { source: 't1', target: 'a1' },
        {
          kindOf,
          edges: [{ source: 't1', target: 'a1' }],
        },
      ),
    ).toBe(false);
  });

  it('counts per (node, edge kind, other END’s kind), never per side', () => {
    // The grain is the whole of it: an agent takes one trigger AND one agent's
    // data on the same in-side, so a count of the side as a whole would refuse
    // a wire the daemon accepts.
    expect(
      arityAllowsConnection(
        'data',
        { source: 'a2', target: 'a1' },
        {
          kindOf,
          edges: [{ source: 't1', target: 'a1' }],
        },
      ),
    ).toBe(true);
  });

  it('still lets an agent fan out to several agents', () => {
    expect(
      arityAllowsConnection(
        'data',
        { source: 'a1', target: 'a3' },
        {
          kindOf,
          edges: [{ source: 'a1', target: 'a2' }],
        },
      ),
    ).toBe(true);
  });

  it('ignores edges of another KIND between the same two nodes', () => {
    // `call` and `data` are counted separately, so a call edge already drawn
    // must not consume the data edge's single slot.
    expect(
      arityAllowsConnection(
        'data',
        { source: 't1', target: 'a1' },
        {
          kindOf,
          edges: [{ source: 't1', target: 'a1', type: 'call' }],
        },
      ),
    ).toBe(true);
  });

  it('refuses a node the canvas does not hold', () => {
    expect(
      arityAllowsConnection(
        'data',
        { source: 't1', target: 'gone' },
        {
          kindOf,
          edges: [],
        },
      ),
    ).toBe(false);
  });
});

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
  it('round-trips the canvas discriminator — EVERY kind names its type now', () => {
    expect(flowEdgeKind({ type: 'call' })).toBe('call');
    // Any third RF edge type is by definition a data edge (documented design).
    expect(flowEdgeKind({ type: 'smoothstep' })).toBe('data');
    expect(flowEdgeType('call')).toEqual({ type: 'call' });
    // `data` used to emit `{}` and take React Flow's default component, which
    // is how the wire that orders the run became the only thing on the canvas
    // nobody had designed. It names itself like the other two.
    expect(flowEdgeType('data')).toEqual({ type: 'data' });
    // The pair inverts: building an edge then reading it back keeps the kind.
    expect(flowEdgeKind(flowEdgeType('call'))).toBe('call');
    expect(flowEdgeKind(flowEdgeType('data'))).toBe('data');
  });

  it('still reads an edge with NO type as data', () => {
    // Not redundant with the round-trip above, and it is the half that cannot
    // be dropped: every edge persisted or dragged before `data` started naming
    // itself carries no type at all, and a drag in flight has none either.
    expect(flowEdgeKind({})).toBe('data');
    expect(flowEdgeKind({ type: undefined })).toBe('data');
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
