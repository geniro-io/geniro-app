import { describe, expect, it } from 'vitest';

import type { Workflow } from '../graphs.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  canonicalGraphYaml,
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

const stages: NonNullable<Workflow['stages']> = [
  { id: 'build', title: 'Build', doneWhen: 'It compiles', next: ['ship'] },
  { id: 'ship', title: 'Ship', doneWhen: 'It is released' },
];

function edit(change: (workflow: Workflow) => Workflow): string {
  return workflowVersionOf(change(structuredClone(base)));
}

describe('workflowVersionOf', () => {
  it('is 16 hex characters', () => {
    expect(workflowVersionOf(base)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('hashes a stage-less workflow as the canonical JSON without a stages key', () => {
    const { maxActiveTurns, nodes, edges } = canonicalGraphOf(base);
    const withoutKey = JSON.stringify({
      edges: edges.map((edge) =>
        Object.fromEntries(
          Object.entries(edge).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      ),
      maxActiveTurns,
      nodes: nodes.map((node) =>
        Object.fromEntries(
          Object.entries(node).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      ),
    });

    expect(canonicalGraphJson(canonicalGraphOf(base))).toBe(withoutKey);
    expect(canonicalGraphJson(canonicalGraphOf(base))).not.toContain('stages');
    expect(workflowVersionOf({ ...base, stages: undefined })).toBe(
      workflowVersionOf(base),
    );
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
    ['an empty stage list', (w) => ({ ...w, stages: [] })],
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
    ['an added stage', (w) => ({ ...w, stages: stages })],
    [
      'a stage field',
      (w) => ({
        ...w,
        stages: stages.map((s) =>
          s.id === 'ship' ? { ...s, doneWhen: 'It is live' } : s,
        ),
      }),
    ],
    ['the stage order', (w) => ({ ...w, stages: [...stages].reverse() })],
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

  it('round-trips the stages in their authored order', () => {
    const staged = { ...base, stages: [...stages].reverse() };
    const back = workflowOfCanonical(
      canonicalGraphJson(canonicalGraphOf(staged)),
    );

    expect(back!.stages).toEqual(staged.stages);
    expect(workflowVersionOf(back!)).toBe(workflowVersionOf(staged));
  });

  it('answers null for a graph the schema no longer reads', () => {
    expect(workflowOfCanonical('not json')).toBeNull();
    expect(workflowOfCanonical('{"nodes":[{"id":"x"}],"edges":[]}')).toBeNull();
  });
});

describe('canonicalGraphYaml', () => {
  it('prints the cap, nodes and edges in the file’s field order, without the name, description or layout', () => {
    const yaml = canonicalGraphYaml(
      canonicalGraphJson(canonicalGraphOf(base)),
    )!;

    expect(yaml.startsWith('maxActiveTurns: 3\nnodes:\n')).toBe(true);
    expect(yaml).toContain('  - id: lead\n    name: Lead\n    kind: agent\n');
    expect(yaml).toContain('edges:\n');
    expect(yaml).not.toContain('Dev Team');
    expect(yaml).not.toContain('Builds things');
    expect(yaml).not.toContain('layout');
    expect(yaml).not.toContain('brief');
  });

  it('prints the stages after the edges, and nothing for a stage-less graph', () => {
    const yaml = canonicalGraphYaml(
      canonicalGraphJson(canonicalGraphOf({ ...base, stages })),
    )!;

    expect(yaml.indexOf('stages:\n')).toBeGreaterThan(yaml.indexOf('edges:\n'));
    expect(yaml).toContain('  - id: build\n    title: Build\n');
    expect(
      canonicalGraphYaml(canonicalGraphJson(canonicalGraphOf(base))),
    ).not.toContain('stages');
  });

  it('answers null for a graph the schema no longer reads', () => {
    expect(canonicalGraphYaml('{"nodes":"no"}')).toBeNull();
  });
});
