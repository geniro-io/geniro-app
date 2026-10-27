import { describe, expect, it } from 'vitest';

import type { Workflow } from '../graphs.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  workflowOfCanonical,
  workflowVersionOf,
} from './workflow-version';

const base: Workflow = {
  name: 'Dev Team',
  description: 'Builds things',
  maxActiveTurns: 3,
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    {
      id: 'lead',
      kind: 'agent',
      agent: 'claude',
      approval: 'auto',
      name: 'Lead',
      role: 'Plan the work',
    },
    { id: 'dev', kind: 'agent', agent: 'codex', approval: 'auto' },
  ],
  edges: [
    { from: 'start', to: 'lead', kind: 'data', label: 'brief' },
    { from: 'lead', to: 'dev', kind: 'call' },
  ],
  layout: { start: { x: 0, y: 0 }, lead: { x: 100, y: 0 } },
};

function edit(change: (workflow: Workflow) => Workflow): string {
  return workflowVersionOf(change(structuredClone(base)));
}

describe('workflowVersionOf', () => {
  it('is 16 hex characters', () => {
    expect(workflowVersionOf(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it.each<[string, (workflow: Workflow) => Workflow]>([
    ['the workflow name', (w) => ({ ...w, name: 'Renamed' })],
    ['the workflow description', (w) => ({ ...w, description: undefined })],
    ['the layout', (w) => ({ ...w, layout: { start: { x: 5, y: 9 } } })],
    [
      'an edge label',
      (w) => ({
        ...w,
        edges: w.edges.map((e) => ({ ...e, label: 'renamed' })),
      }),
    ],
    ['the node order', (w) => ({ ...w, nodes: [...w.nodes].reverse() })],
    ['the edge order', (w) => ({ ...w, edges: [...w.edges].reverse() })],
    [
      'the key order inside a node',
      (w) => ({
        ...w,
        nodes: w.nodes.map(
          (n) =>
            Object.fromEntries(
              Object.entries(n).reverse(),
            ) as Workflow['nodes'][number],
        ),
      }),
    ],
  ])('keeps the id across an edit to %s', (_what, change) => {
    expect(edit(change)).toBe(workflowVersionOf(base));
  });

  it.each<[string, (workflow: Workflow) => Workflow]>([
    [
      'a node field',
      (w) => ({
        ...w,
        nodes: w.nodes.map((n) =>
          n.id === 'lead' ? { ...n, role: 'Review the work' } : n,
        ),
      }),
    ],
    [
      'a node name',
      (w) => ({
        ...w,
        nodes: w.nodes.map((n) =>
          n.id === 'lead' ? { ...n, name: 'Tech lead' } : n,
        ),
      }),
    ],
    [
      'an added node',
      (w) => ({
        ...w,
        nodes: [
          ...w.nodes,
          { id: 'qa', kind: 'agent', agent: 'claude', approval: 'auto' },
        ],
      }),
    ],
    [
      'a removed node',
      (w) => ({ ...w, nodes: w.nodes.filter((n) => n.id !== 'dev') }),
    ],
    [
      'an added edge',
      (w) => ({
        ...w,
        edges: [...w.edges, { from: 'start', to: 'dev', kind: 'data' }],
      }),
    ],
    ['a removed edge', (w) => ({ ...w, edges: w.edges.slice(0, 1) })],
    [
      'an edge kind',
      (w) => ({
        ...w,
        edges: w.edges.map((e) =>
          e.to === 'dev' ? { ...e, kind: 'data' as const } : e,
        ),
      }),
    ],
    ['maxActiveTurns', (w) => ({ ...w, maxActiveTurns: 4 })],
    ['maxActiveTurns removed', (w) => ({ ...w, maxActiveTurns: undefined })],
  ])('changes the id on %s', (_what, change) => {
    expect(edit(change)).not.toBe(workflowVersionOf(base));
  });
});

describe('canonicalGraphOf', () => {
  it('drops the workflow name, description, layout and edge labels', () => {
    const json = canonicalGraphJson(canonicalGraphOf(base));
    expect(json).not.toContain('Dev Team');
    expect(json).not.toContain('Builds things');
    expect(json).not.toContain('layout');
    expect(json).not.toContain('brief');
    expect(json).toContain('Plan the work');
  });
});

describe('workflowOfCanonical', () => {
  it('reads a stored graph back with the same version', () => {
    const back = workflowOfCanonical(
      canonicalGraphJson(canonicalGraphOf(base)),
    );
    expect(back).not.toBeNull();
    expect(workflowVersionOf(back!)).toBe(workflowVersionOf(base));
  });

  it('answers null for a graph the schema no longer reads', () => {
    expect(workflowOfCanonical('not json')).toBeNull();
    expect(workflowOfCanonical('{"nodes":[{"id":"x"}],"edges":[]}')).toBeNull();
  });
});
