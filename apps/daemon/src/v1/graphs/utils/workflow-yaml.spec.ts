import { BadRequestException } from '@packages/common';
import { describe, expect, it } from 'vitest';

import { agentNode, instructionNode } from '../__tests__/workflow-node';
import type { Workflow } from '../graphs.types';
import { parseWorkflowYaml, serializeWorkflowYaml } from './workflow-yaml';

const VALID_SOURCE = `# My review team
name: review-team
nodes:
  # the coder writes the change
  - id: coder
    kind: agent
    agent: claude
    role: You write the code.
  - id: reviewer
    kind: agent
    agent: cursor-agent
    approval: ask
edges:
  - from: coder
    to: reviewer
    kind: data
`;

describe('parseWorkflowYaml', () => {
  it('parses a valid workflow and fills zod defaults', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    expect(wf.name).toBe('review-team');
    expect(wf.nodes).toHaveLength(2);
    expect(agentNode(wf.nodes[0]).approval).toBe('auto');
    expect(agentNode(wf.nodes[1]).approval).toBe('ask');
    expect(wf.edges).toEqual([{ from: 'coder', to: 'reviewer', kind: 'data' }]);
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
      parseWorkflowYaml(
        'name: x\nnodes:\n  - id: a\n    kind: agent\n    agent: gpt\n',
      );
      expect.unreachable('expected a schema rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const exception = err as BadRequestException;
      expect(exception.errorCode).toBe('WORKFLOW_YAML_INVALID');
      expect(exception.getMessage()).toContain('nodes.0.agent');
    }
  });

  it('rejects a kind-less node — the legacy preprocess shim is gone', () => {
    // Strict schema (no-backcompat): `kind` is required on every node. Kind-less
    // legacy files are rejected outright — there is no normalization shim, in
    // the schema OR the store (parseLegacyWorkflowYaml + the .bak retry are gone).
    try {
      parseWorkflowYaml('name: old\nnodes:\n  - id: a\n    agent: claude\n');
      expect.unreachable('expected a strict-schema rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).errorCode).toBe(
        'WORKFLOW_YAML_INVALID',
      );
    }
  });

  it('rejects a kind-less edge naming the offending path', () => {
    const source = `name: x
nodes:
  - id: a
    kind: agent
    agent: claude
  - id: b
    kind: agent
    agent: claude
edges:
  - from: a
    to: b
`;
    try {
      parseWorkflowYaml(source);
      expect.unreachable('expected a strict-schema rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const exception = err as BadRequestException;
      expect(exception.errorCode).toBe('WORKFLOW_YAML_INVALID');
      expect(exception.getMessage()).toContain('edges.0.kind');
    }
  });
});

describe('serializeWorkflowYaml', () => {
  it('emits parseable YAML for a fresh workflow (no existing source)', () => {
    const wf: Workflow = {
      name: 'fresh',
      nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
      edges: [],
      layout: { a: { x: 10, y: 20 } },
    };
    const out = serializeWorkflowYaml(wf);
    const back = parseWorkflowYaml(out);
    expect(back).toEqual(wf);
  });

  it('round-trips trigger nodes and call edges', () => {
    const wf: Workflow = {
      name: 'triggered',
      nodes: [
        { id: 'start', kind: 'trigger', trigger: 'manual' },
        { id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' },
        { id: 'b', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [
        { from: 'start', to: 'a', kind: 'data' },
        { from: 'a', to: 'b', kind: 'call' },
      ],
    };
    const back = parseWorkflowYaml(serializeWorkflowYaml(wf));
    expect(back).toEqual(wf);
  });

  it('keeps a data edge and a call edge between the same pair distinct on save', () => {
    // The edge identity is (from, to, kind): both wires between one ordered
    // pair must survive the comment-preserving merge — a from→to key would
    // silently drop one of them.
    const source = `name: pair
nodes:
  - id: a
    kind: agent
    agent: claude
  - id: b
    kind: agent
    agent: claude
edges:
  # data flows a to b
  - from: a
    to: b
    kind: data
  - from: a
    to: b
    kind: call
`;
    const wf = parseWorkflowYaml(source);
    expect(wf.edges).toHaveLength(2);
    const out = serializeWorkflowYaml(wf, source);
    expect(out).toContain('# data flows a to b');
    const back = parseWorkflowYaml(out);
    expect(back.edges).toEqual([
      { from: 'a', to: 'b', kind: 'data' },
      { from: 'a', to: 'b', kind: 'call' },
    ]);
  });

  it('preserves user comments when patching an existing file', () => {
    const wf = parseWorkflowYaml(VALID_SOURCE);
    agentNode(wf.nodes[0]).model = 'opus';
    wf.layout = { coder: { x: 0, y: 0 }, reviewer: { x: 200, y: 0 } };
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    expect(out).toContain('# My review team');
    expect(out).toContain('# the coder writes the change');
    const back = parseWorkflowYaml(out);
    expect(agentNode(back.nodes[0]).model).toBe('opus');
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
      nodes: [
        ...wf.nodes,
        { id: 'tester', kind: 'agent', agent: 'claude', approval: 'auto' },
      ],
      edges: [...wf.edges, { from: 'reviewer', to: 'tester', kind: 'data' }],
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
    delete agentNode(wf.nodes[0]).role;
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    const back = parseWorkflowYaml(out);
    expect(agentNode(back.nodes[0]).role).toBeUndefined();
  });

  it('writes an agent description back into an existing file', () => {
    // The merge patches a fixed field list, so a field missing from it is
    // silently dropped on every save of a pre-existing file — and description
    // is what callers route on, so losing it breaks the graph quietly.
    const wf = parseWorkflowYaml(VALID_SOURCE);
    const coder = wf.nodes[0]!;
    if (coder.kind !== 'agent') {
      expect.unreachable('the coder fixture is an agent node');
    }
    coder.description = 'Writes the change.';
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    const back = parseWorkflowYaml(out);
    const saved = back.nodes[0]!;
    expect(saved.kind).toBe('agent');
    expect((saved as typeof coder).description).toBe('Writes the change.');
    // ...and the hand-written comments still survive the round-trip.
    expect(out).toContain('# the coder writes the change');
  });

  it('writes an agent configDir back into an existing file', () => {
    // Same hazard as description above, and the reason this test drives the
    // MERGE path specifically: `serializeWorkflowYaml(wf)` with no source goes
    // through `workflowToPlain`, a JSON round-trip that emits every field
    // whether or not the merge's field list knows about it. A no-source round
    // trip therefore stays GREEN with `configDir` missing from
    // AGENT_ONLY_FIELDS, so it would certify a mirror that silently drops the
    // field on every save of a pre-existing workflow.
    const wf = parseWorkflowYaml(VALID_SOURCE);
    const coder = wf.nodes[0]!;
    if (coder.kind !== 'agent') {
      expect.unreachable('the coder fixture is an agent node');
    }
    coder.configDir = '/opt/plugins/reviewer';
    const out = serializeWorkflowYaml(wf, VALID_SOURCE);
    const back = parseWorkflowYaml(out);
    const saved = back.nodes[0]!;
    expect(saved.kind).toBe('agent');
    expect((saved as typeof coder).configDir).toBe('/opt/plugins/reviewer');
    expect(out).toContain('# the coder writes the change');
  });

  it('clears a configDir the inspector removed', () => {
    // The delete half of the mirror: `setOrDelete` only reaches a key the
    // field list names, so an unmirrored field could never be cleared from a
    // file that already carried one.
    const sourceWithConfigDir = VALID_SOURCE.replace(
      '    role: You write the code.',
      '    role: You write the code.\n    configDir: /opt/plugins/reviewer',
    );
    const wf = parseWorkflowYaml(sourceWithConfigDir);
    const coder = wf.nodes[0]!;
    if (coder.kind !== 'agent') {
      expect.unreachable('the coder fixture is an agent node');
    }
    expect(coder.configDir).toBe('/opt/plugins/reviewer');
    delete coder.configDir;
    const out = serializeWorkflowYaml(wf, sourceWithConfigDir);
    expect(out).not.toContain('/opt/plugins/reviewer');
    const saved = parseWorkflowYaml(out).nodes[0]!;
    expect(saved.kind).toBe('agent');
    expect((saved as typeof coder).configDir).toBeUndefined();
  });

  it('does not emit a node twice when the existing file already holds its id twice', () => {
    // A hand-edited file where the user copy-pasted a node block and forgot to
    // change the id. The saved workflow itself is valid (each id once); the
    // merge must not propagate the duplicate back to disk, or get()/run of the
    // saved file returns duplicate node ids that graph validation rejects.
    const dupSource = `name: review-team
nodes:
  - id: coder
    kind: agent
    agent: claude
  - id: coder
    kind: agent
    agent: claude
  - id: reviewer
    kind: agent
    agent: cursor-agent
edges: []
`;
    const wf: Workflow = {
      name: 'review-team',
      nodes: [
        { id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' },
        {
          id: 'reviewer',
          kind: 'agent',
          agent: 'cursor-agent',
          approval: 'auto',
        },
      ],
      edges: [],
    };
    const out = serializeWorkflowYaml(wf, dupSource);
    const back = parseWorkflowYaml(out);
    expect(back.nodes.map((n) => n.id)).toEqual(['coder', 'reviewer']);
  });

  it('rewrites a retained legacy kind-less edge item with its kind explicit', () => {
    // The merge keys edges by (from, to, kind); a legacy item without `kind`
    // never matches, so it is dropped and re-appended fully-specified — the
    // saved file is always strict-parseable.
    const legacyEdgeSource = `name: review-team
nodes:
  - id: coder
    kind: agent
    agent: claude
  - id: reviewer
    kind: agent
    agent: cursor-agent
edges:
  - from: coder
    to: reviewer
`;
    const wf: Workflow = {
      name: 'review-team',
      nodes: [
        { id: 'coder', kind: 'agent', agent: 'claude', approval: 'auto' },
        {
          id: 'reviewer',
          kind: 'agent',
          agent: 'cursor-agent',
          approval: 'auto',
        },
      ],
      edges: [{ from: 'coder', to: 'reviewer', kind: 'data' }],
    };
    const out = serializeWorkflowYaml(wf, legacyEdgeSource);
    const back = parseWorkflowYaml(out);
    expect(back.edges).toEqual([
      { from: 'coder', to: 'reviewer', kind: 'data' },
    ]);
  });

  it('falls back to a clean dump when the existing source is unparseable', () => {
    const wf: Workflow = {
      name: 'rescued',
      nodes: [{ id: 'a', kind: 'agent', agent: 'claude', approval: 'auto' }],
      edges: [],
    };
    const out = serializeWorkflowYaml(wf, 'nodes: [\nname: :');
    expect(parseWorkflowYaml(out)).toEqual(wf);
  });
});

const INSTRUCTION_SOURCE = `name: with-notes
nodes:
  # the house style every writer shares
  - id: style
    kind: instruction
    instructions: Prefer short sentences.
  - id: writer
    kind: agent
    agent: claude
edges:
  - from: style
    to: writer
    kind: instruction
`;

describe('instruction nodes', () => {
  it('parses an instruction node and its edge', () => {
    const wf = parseWorkflowYaml(INSTRUCTION_SOURCE);
    expect(instructionNode(wf.nodes[0]).instructions).toBe(
      'Prefer short sentences.',
    );
    expect(wf.edges).toEqual([
      { from: 'style', to: 'writer', kind: 'instruction' },
    ]);
  });

  // A block is dropped on the canvas before it is written, so the YAML schema
  // has to accept one that names no text at all.
  it('defaults a block that names no key at all', () => {
    const wf = parseWorkflowYaml(
      'name: n\nnodes:\n  - id: style\n    kind: instruction\n',
    );
    expect(instructionNode(wf.nodes[0]).instructions).toBe('');
  });

  // A hand-written `instructions:` with nothing after it parses as NULL, not
  // undefined — which a plain `.default('')` never fires for, so a block a
  // user scaffolded and had not filled in yet made its whole workflow
  // unopenable. This is the case the schema's `.nullish()` exists for.
  it('accepts a block whose key is present but empty', () => {
    const wf = parseWorkflowYaml(
      'name: n\nnodes:\n  - id: style\n    kind: instruction\n    instructions:\n',
    );
    expect(instructionNode(wf.nodes[0]).instructions).toBe('');
  });

  // The merge path writes each kind's own fields back from a per-kind
  // registry; a field missing from that registry is silently dropped on every
  // save of a pre-existing file, which a plain round trip cannot catch.
  it('keeps the instruction text through a comment-preserving save', () => {
    const wf = parseWorkflowYaml(INSTRUCTION_SOURCE);
    instructionNode(wf.nodes[0]).instructions =
      'Prefer short sentences. Cite files.';
    const out = serializeWorkflowYaml(wf, INSTRUCTION_SOURCE);
    expect(out).toContain('# the house style every writer shares');
    expect(parseWorkflowYaml(out).nodes[0]).toEqual({
      id: 'style',
      kind: 'instruction',
      instructions: 'Prefer short sentences. Cite files.',
    });
  });

  it('drops the previous kind’s keys when a node flips to instruction', () => {
    const source = `name: n
nodes:
  - id: style
    kind: agent
    agent: claude
    approval: auto
    role: old role
edges: []
`;
    const flipped: Workflow = {
      name: 'n',
      nodes: [{ id: 'style', kind: 'instruction', instructions: 'Be terse.' }],
      edges: [],
    };
    const out = serializeWorkflowYaml(flipped, source);
    expect(out).not.toContain('role:');
    expect(out).not.toContain('approval:');
    expect(parseWorkflowYaml(out).nodes[0]).toEqual({
      id: 'style',
      kind: 'instruction',
      instructions: 'Be terse.',
    });
  });
});

const FIELD_COMMENT_SOURCE = `name: annotated
nodes:
  - id: coder
    kind: agent
    # which CLI drives this node
    agent: claude
    model: opus
    role: You write the code.
edges: []
`;

describe('comment-preserving merge — node FIELD comments', () => {
  // Every other fixture here puts its comments above a NODE or the document.
  // A comment on a node FIELD is the position the merge can destroy without
  // any of them noticing: `YAMLMap.delete` drops the pair carrying the key's
  // comment and the following `set` re-appends the key at the end, so the
  // annotation is gone and the file's field order is rewritten — on every
  // canvas save, for a value that did not even change.
  it('keeps a comment written on a node field, and the file’s field order', () => {
    const wf = parseWorkflowYaml(FIELD_COMMENT_SOURCE);
    agentNode(wf.nodes[0]).model = 'sonnet';
    const out = serializeWorkflowYaml(wf, FIELD_COMMENT_SOURCE);

    expect(out).toContain('# which CLI drives this node');
    expect(out.indexOf('agent:')).toBeLessThan(out.indexOf('model:'));
    expect(out.indexOf('model:')).toBeLessThan(out.indexOf('role:'));
    expect(agentNode(parseWorkflowYaml(out).nodes[0]).model).toBe('sonnet');
  });

  it('clears a field the canvas removed without disturbing its neighbours', () => {
    const wf = parseWorkflowYaml(FIELD_COMMENT_SOURCE);
    delete agentNode(wf.nodes[0]).role;
    const out = serializeWorkflowYaml(wf, FIELD_COMMENT_SOURCE);

    expect(out).toContain('# which CLI drives this node');
    expect(out).not.toContain('role:');
    expect(agentNode(parseWorkflowYaml(out).nodes[0]).model).toBe('opus');
  });
});

describe('instruction text is bounded like the user’s own instructions', () => {
  // The text becomes claude's `--append-system-prompt` argv, where a NUL makes
  // `spawn` throw SYNCHRONOUSLY — and a workflow is a FILE, which can be
  // imported from someone else. Refusing it at the parse is the only place
  // that can name the problem; the builder renders the character as nothing.
  it('refuses a control character in a block', () => {
    const source =
      'name: n\nnodes:\n  - id: style\n    kind: instruction\n    instructions: "a\\u0000b"\n';
    try {
      parseWorkflowYaml(source);
      expect.unreachable('expected a schema rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const exception = err as BadRequestException;
      expect(exception.errorCode).toBe('WORKFLOW_YAML_INVALID');
      expect(exception.getMessage()).toContain('nodes.0.instructions');
    }
  });

  it('still accepts an empty block — one is dropped before it is written', () => {
    const wf = parseWorkflowYaml(
      'name: n\nnodes:\n  - id: style\n    kind: instruction\n    instructions: ""\n',
    );
    expect(instructionNode(wf.nodes[0]).instructions).toBe('');
  });
});
