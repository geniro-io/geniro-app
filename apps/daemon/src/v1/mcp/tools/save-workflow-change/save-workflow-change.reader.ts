import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** Edits per save — a change that needs more is a new workflow, made in the builder. */
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

export const SaveWorkflowChangeArgsSchema = z.object({
  edits: z
    .array(WorkflowEditSchema)
    .min(1)
    .max(MAX_WORKFLOW_EDITS)
    .describe(
      'The changes, applied in order to the workflow as view="workflow" returned it — only what changes, never the whole workflow',
    ),
  baseHash: z
    .string()
    .min(1)
    .max(64)
    .describe('The `hash` view="workflow" returned when you read it'),
  ids: z
    .array(
      RecommendationIdSchema.regex(/^W-/, 'only W- items change the workflow'),
    )
    .min(1)
    .max(MAX_RECOMMENDATIONS_PER_TARGET)
    .describe('The W-n ids this change carries out'),
  dryRun: z
    .boolean()
    .optional()
    .describe('true answers the diff without saving'),
});
export type SaveWorkflowChangeArgs = z.infer<
  typeof SaveWorkflowChangeArgsSchema
>;

/** A `save_workflow_change` call's arguments, or why they cannot be read. */
export function readSaveWorkflowChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<SaveWorkflowChangeArgs> {
  return readToolArgs(SaveWorkflowChangeArgsSchema.strict(), args);
}

/** The answer as the agent reads it, and whether it is a refusal. */
export function workflowChangeResultText(answer: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  return { text: JSON.stringify(answer), isError: 'error' in answer };
}
