import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { editsField } from '../team-edit-args';
import { readToolArgs } from '../tool-args';

/** An analysis's save: what it changes, and which applied recommendations that carries out. */
export const SaveTeamChangeArgsSchema = z.object({
  edits: editsField('the team as view="team" returned it'),
  baseHash: z
    .string()
    .min(1)
    .max(64)
    .describe('The `hash` view="team" returned when you read it'),
  ids: z
    .array(RecommendationIdSchema.regex(/^W-/, 'only W- items change the team'))
    .min(1)
    .max(MAX_RECOMMENDATIONS_PER_TARGET)
    .describe('The W-n ids this change carries out'),
  dryRun: z
    .boolean()
    .optional()
    .describe('true answers the diff without saving'),
});
export type SaveTeamChangeArgs = z.infer<typeof SaveTeamChangeArgsSchema>;

/**
 * A builder chat's check: only the edits. It never saves — the change is
 * written behind `propose_team`'s card — so it takes no `dryRun`; no
 * recommendation ids and no hash either, since the agent reads the file with
 * its own tools and the daemon tracks the version per turn. Each is refused as
 * unknown.
 */
export const BuilderTeamChangeArgsSchema = z.object({
  edits: editsField('the team file as it stands'),
});
export type BuilderTeamChangeArgs = z.infer<typeof BuilderTeamChangeArgsSchema>;

/** An analysis's `save_team_change` arguments, or why they cannot be read. */
export function readSaveTeamChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<SaveTeamChangeArgs> {
  return readToolArgs(SaveTeamChangeArgsSchema.strict(), args);
}

/** A builder chat's `save_team_change` arguments, or why they cannot be read. */
export function readBuilderTeamChangeArgs(
  args: Record<string, unknown>,
): ToolArgs<BuilderTeamChangeArgs> {
  return readToolArgs(BuilderTeamChangeArgsSchema.strict(), args);
}

/** The answer as the agent reads it, and whether it is a refusal. */
export function teamChangeResultText(answer: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  return { text: JSON.stringify(answer), isError: 'error' in answer };
}
