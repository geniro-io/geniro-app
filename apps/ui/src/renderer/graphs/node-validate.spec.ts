import { describe, expect, it } from 'vitest';

import type { CliKind, WorkflowNode } from '../../shared/contracts';
import { validateNode } from './node-validate';

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

function edge(
  source: string,
  target: string,
): { source: string; target: string } {
  return { source, target };
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
          'No input connected — wire a trigger or an upstream agent into this node.',
      },
    ]);
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
      'This trigger node cannot feed a trigger node.',
    );
    expect(
      validateNode(trigger2, KINDS, edges).map((e) => e.message),
    ).toContain('A trigger node cannot feed this trigger node.');
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
      'No input connected — wire a trigger or an upstream agent into this node.',
    ]);
  });
});
