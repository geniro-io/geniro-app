import { z } from 'zod';

/** Edits per save or proposal — a change that needs more is a new workflow, made in the builder. */
const MAX_WORKFLOW_EDITS = 50;

/** One edit — `WorkflowEdit` (`graphs/utils/workflow-edits.ts`) says what each shape does. */
const WorkflowEditSchema = z.union([
  z
    .object({
      find: z
        .string()
        .min(1)
        .describe(
          'Exact text inside one string value of the workflow (a role, the instructions), occurring exactly once in the whole workflow',
        ),
      replace: z.string().describe('What replaces it'),
    })
    .strict(),
  z
    .object({
      path: z
        .string()
        .min(1)
        .describe('The field to delete, e.g. "nodes/reviewer/model"'),
      remove: z.literal(true),
    })
    .strict(),
  z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          'The field to set, "/"-separated; in a list a segment is an index, an element\'s id ("nodes/reviewer/model") or "-" to append ("edges/-")',
        ),
      value: z.unknown().describe('The new value, any JSON'),
    })
    .strict(),
]);

/** The edits, described against the copy of the workflow the agent read. */
export function editsField(readCopy: string) {
  return z
    .array(WorkflowEditSchema)
    .min(1)
    .max(MAX_WORKFLOW_EDITS)
    .describe(
      `The changes, applied in order to ${readCopy} — only what changes, never the whole workflow`,
    );
}
