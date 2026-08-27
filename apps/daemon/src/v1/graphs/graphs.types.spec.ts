import { describe, expect, it } from 'vitest';

import { MAX_CUSTOM_INSTRUCTIONS_CHARS } from '../agents/chat.types';
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

  it('refuses text over the shared instruction ceiling', () => {
    expect(parse('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1)).success).toBe(
      false,
    );
    expect(parse('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS)).success).toBe(true);
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
