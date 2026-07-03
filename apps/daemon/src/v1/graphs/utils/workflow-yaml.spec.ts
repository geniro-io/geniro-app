import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import type { Workflow } from '../graphs.types';
import { parseWorkflowYaml, serializeWorkflowYaml } from './workflow-yaml';

const VALID_SOURCE = `# My review team
name: review-team
nodes:
  # the coder writes the change
  - id: coder
    agent: claude
    role: You write the code.
  - id: reviewer
    agent: cursor-agent
    approval: ask
edges:
  - from: coder
    to: reviewer
`;

describe('parseWorkflowYaml', () => {
  it('parses a valid workflow and fills zod defaults', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    expect(wf.name).toBe('review-team');
    expect(wf.nodes).toHaveLength(2);
    expect(wf.nodes[0]!.approval).toBe('auto');
    expect(wf.nodes[1]!.approval).toBe('ask');
    expect(wf.edges).toEqual([{ from: 'coder', to: 'reviewer' }]);
  });

  it('rejects malformed YAML with WORKFLOW_YAML_INVALID', () => {
    try {
      parseWorkflowYaml('nodes: [\nname: :');
      expect.unreachable('expected a parse rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).errorCode).toBe(
        'WORKFLOW_YAML_INVALID',
      );
    }
  });

  it('rejects schema violations naming the offending path', () => {
    try {
      parseWorkflowYaml('name: x\nnodes:\n  - id: a\n    agent: gpt\n');
      expect.unreachable('expected a schema rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const exception = err as BadRequestException;
      expect(exception.errorCode).toBe('WORKFLOW_YAML_INVALID');
      expect(exception.getMessage()).toContain('nodes.0.agent');
    }
  });
});

describe('serializeWorkflowYaml', () => {
  it('emits parseable YAML for a fresh workflow (no existing source)', () => {
    const wf: Workflow = {
      name: 'fresh',
      nodes: [{ id: 'a', agent: 'claude', approval: 'auto' }],
      edges: [],
      layout: { a: { x: 10, y: 20 } },
    };
    const out = serializeWorkflowYaml(wf);
    const back = parseWorkflowYaml(out);
    expect(back).toEqual(wf);
  });

  it('preserves user comments when patching an existing file', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    wf.nodes[0]!.model = 'opus';
    wf.layout = { coder: { x: 0, y: 0 }, reviewer: { x: 200, y: 0 } };
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    expect(out).toContain('# My review team');
    expect(out).toContain('# the coder writes the change');
    const back = parseWorkflowYaml(out);
    expect(back.nodes[0]!.model).toBe('opus');
    expect(back.layout).toEqual(wf.layout);
  });

  it('drops removed nodes and their stale edges from the file', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    const pruned: Workflow = {
      ...wf,
      nodes: wf.nodes.filter((n) => n.id !== 'reviewer'),
      edges: [],
    };
    const out = serializeWorkflowYaml(pruned, VALID_SOURCE);
    expect(out).not.toContain('reviewer');
    const back = parseWorkflowYaml(out);
    expect(back.nodes).toHaveLength(1);
    expect(back.edges).toEqual([]);
  });

  it('appends new nodes and edges while keeping existing entries', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    const grown: Workflow = {
      ...wf,
      nodes: [...wf.nodes, { id: 'tester', agent: 'claude', approval: 'auto' }],
      edges: [...wf.edges, { from: 'reviewer', to: 'tester' }],
    };
    const out = serializeWorkflowYaml(grown, VALID_SOURCE);
    expect(out).toContain('# the coder writes the change');
    const back = parseWorkflowYaml(out);
    expect(back.nodes.map((n) => n.id)).toEqual([
      'coder',
      'reviewer',
      'tester',
    ]);
    expect(back.edges).toHaveLength(2);
  });

  it('clears an optional field the canvas removed', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    delete wf.nodes[0]!.role;
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    const back = parseWorkflowYaml(out);
    expect(back.nodes[0]!.role).toBeUndefined();
  });

  it('does not emit a node twice when the existing file already holds its id twice', () => {
    // A hand-edited file where the user copy-pasted a node block and forgot to
    // change the id. The saved workflow itself is valid (each id once); the
    // merge must not propagate the duplicate back to disk, or get()/run of the
    // saved file returns duplicate node ids that graph validation rejects.
    const dupSource = `name: review-team
nodes:
  - id: coder
    agent: claude
  - id: coder
    agent: claude
  - id: reviewer
    agent: cursor-agent
edges: []
`;
    const wf: Workflow = {
      name: 'review-team',
      nodes: [
        { id: 'coder', agent: 'claude', approval: 'auto' },
        { id: 'reviewer', agent: 'cursor-agent', approval: 'auto' },
      ],
      edges: [],
    };
    const out = serializeWorkflowYaml(wf, dupSource);
    const back = parseWorkflowYaml(out);
    expect(back.nodes.map((n) => n.id)).toEqual(['coder', 'reviewer']);
  });

  it('falls back to a clean dump when the existing source is unparseable', () => {
    const wf: Workflow = {
      name: 'rescued',
      nodes: [{ id: 'a', agent: 'claude', approval: 'auto' }],
      edges: [],
    };
    const out = serializeWorkflowYaml(wf, 'nodes: [\nname: :');
    expect(parseWorkflowYaml(out)).toEqual(wf);
  });
});
