import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';
import { editsField } from '../workflow-edit-args';

/** An analysis's save: what it changes, and which applied recommendations that carries out. */
export const SaveWorkflowChangeArgsSchema = z.object({
  edits: editsField('the workflow as view="workflow" returned it'),
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

/**
 * A builder chat's check: only the edits. It never saves — the change is
 * written behind `propose_workflow`'s card — so it takes no `dryRun`; no
 * recommendation ids and no hash either, since the agent reads the file with
 * its own tools and the daemon tracks the version per turn. Each is refused as
 * unknown.
 */
export const BuilderWorkflowChangeArgsSchema = z.object({
  edits: editsField('the workflow file as it stands'),
});
export type BuilderWorkflowChangeArgs = z.infer<
  typeof BuilderWorkflowChangeArgsSchema
>;

/** An analysis's `save_workflow_change` arguments, or why they cannot be read. */
export function readSaveWorkflowChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<SaveWorkflowChangeArgs> {
  return readToolArgs(SaveWorkflowChangeArgsSchema.strict(), args);
}

/** A builder chat's `save_workflow_change` arguments, or why they cannot be read. */
export function readBuilderWorkflowChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<BuilderWorkflowChangeArgs> {
  return readToolArgs(BuilderWorkflowChangeArgsSchema.strict(), args);
}

/** The answer as the agent reads it, and whether it is a refusal. */
export function workflowChangeResultText(answer: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  return { text: JSON.stringify(answer), isError: 'error' in answer };
}
