import { describe, expect, it } from 'vitest';

import { WorkflowSchema } from './graphs.types';

/**
 * The STRICT schema — the one the HTTP routes validate against
 * (`CreateWorkflowDto` / `SaveWorkflowDto`), which is the door the builder
 * autosaves through. `WorkflowYamlSchema` layers YAML leniency on top and is
 * covered by `utils/workflow-yaml.spec.ts`; a bound pinned only there would
 * leave this arm free to drift, and a control character accepted here is
 * written to YAML and then makes every later read of that file throw.
 */
function parse(
  instructions: unknown,
): ReturnType<typeof WorkflowSchema.safeParse> {
  return WorkflowSchema.safeParse({
    name: 'n',
    nodes: [{ id: 'style', kind: 'instruction', instructions }],
    edges: [],
  });
}

describe('WorkflowInstructionNodeSchema.instructions', () => {
  it('refuses a control character', () => {
    // Written as the ESCAPE, never the raw byte: a NUL in a .ts file makes
    // git classify the blob as binary — no diff, no inline review comments,
    // no three-way merge — and the pre-commit hook refuses it for that reason.
    const result = parse('a\u0000b');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      'control characters',
    );
  });

  // Instruction text has no size limit: a block past the old 16,000-character
  // cap made its whole workflow fail to load.
  it('accepts text of any length', () => {
    expect(parse('x'.repeat(100_000)).success).toBe(true);
  });

  // A block is dropped on the canvas before it is written, so the strict
  // schema has to accept the empty string the builder creates it with.
  it('accepts the empty string', () => {
    expect(parse('').success).toBe(true);
  });

  // Only the YAML layer defaults it — the wire shape is deliberately
  // default-free so its request and response renderings collapse to one type.
  it('requires the field on the wire', () => {
    expect(parse(undefined).success).toBe(false);
  });
});

/**
 * Every OTHER node string that reaches a spawned CLI. `role` is claude's
 * `--append-system-prompt` argv, `name`/`description`/`id` are written into a
 * caller's "May call" block in that same argv, `model`/`effort` are argv flags
 * and `configDir` is the child's env — and node throws at `spawn` on a NUL in
 * any of them, so the node would fail every run of an imported workflow.
 */
describe('agent node text that reaches a CLI refuses a NUL', () => {
  function parseAgent(
    fields: Record<string, unknown>,
  ): ReturnType<typeof WorkflowSchema.safeParse> {
    return WorkflowSchema.safeParse({
      name: 'n',
      nodes: [
        {
          id: 'worker',
          kind: 'agent',
          agent: 'claude',
          approval: 'auto',
          ...fields,
        },
      ],
      edges: [],
    });
  }

  it.each([
    'role',
    'description',
    'name',
    'model',
    'effort',
    'contextWindow',
    'configDir',
  ])('refuses a NUL in `%s`', (field) => {
    const result = parseAgent({ [field]: 'a\u0000b' });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('NUL');
  });

  it('refuses a NUL in a node id', () => {
    const result = WorkflowSchema.safeParse({
      name: 'n',
      nodes: [{ id: 'start\u0000', kind: 'trigger', trigger: 'manual' }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  // The same schema READS the library's YAML and every run's graph copy, so
  // refusing more than what breaks `spawn` locked out stored workflows whose
  // role held a pasted ESC or form-feed — characters a CLI's argv takes fine.
  it('still reads a role holding an ESC or a form-feed', () => {
    expect(
      parseAgent({ role: 'bold \u001b[1mtext\u001b[0m\u000cnext page' })
        .success,
    ).toBe(true);
  });

  // A role is prose: the three C0 characters prose is made of must pass, or
  // every multi-line role written so far would stop loading.
  it('still accepts tabs and line breaks in a role', () => {
    expect(
      parseAgent({ role: 'line one\n\tline two\r\n', description: 'a\nb' })
        .success,
    ).toBe(true);
  });
});

/**
 * `mcpDisabled` — the servers a node (or a pool member) runs WITHOUT. Each name
 * reaches a CLI as argv, a config key or a JSON file, so it refuses every
 * control character; the list and each name are bounded. TWIN:
 * `mcpServerNameProblem` / `MAX_NODE_MCP_DISABLED` in the renderer's
 * `workflows/node-validate.ts`.
 */
describe('WorkflowAgentNode.mcpDisabled', () => {
  function parseWith(
    mcpDisabled: unknown,
    where: 'node' | 'member' = 'node',
  ): ReturnType<typeof WorkflowSchema.safeParse> {
    return WorkflowSchema.safeParse({
      name: 'n',
      nodes: [
        {
          id: 'worker',
          kind: 'agent',
          agent: 'claude',
          approval: 'auto',
          ...(where === 'node'
            ? { mcpDisabled }
            : { pool: [{ agent: 'codex', mcpDisabled }] }),
        },
      ],
      edges: [],
    });
  }

  it('accepts server names on a node and on a pool member', () => {
    expect(parseWith(['codegraph', 'claude.ai Gmail']).success).toBe(true);
    expect(parseWith(['playwright'], 'member').success).toBe(true);
  });

  it.each(['node', 'member'] as const)(
    'refuses an empty name or a control character on a %s',
    (where) => {
      expect(parseWith([''], where).success).toBe(false);
      const tabbed = parseWith(['code\tgraph'], where);
      expect(tabbed.success).toBe(false);
      expect(JSON.stringify(tabbed.error?.issues)).toContain(
        'control characters',
      );
      expect(parseWith(['a\u007fb'], where).success).toBe(false);
    },
  );

  it('bounds the list and each name', () => {
    expect(parseWith(['x'.repeat(256)]).success).toBe(true);
    expect(parseWith(['x'.repeat(257)]).success).toBe(false);
    const many = Array.from({ length: 100 }, (_, i) => `s${i}`);
    expect(parseWith(many).success).toBe(true);
    expect(parseWith([...many, 'one-more']).success).toBe(false);
  });
});
