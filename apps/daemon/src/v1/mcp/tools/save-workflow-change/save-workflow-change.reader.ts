import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

export const SaveWorkflowChangeArgsSchema = z.object({
  workflow: z
    .record(z.string(), z.unknown())
    .describe(
      'The WHOLE edited workflow, as view="workflow" returned it — every node, not only the changed ones',
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
