import { z } from 'zod';

import {
  MAX_RECOMMENDATIONS_PER_TARGET,
  RecommendationIdSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { editsField } from '../team-edit-args';
import { readToolArgs } from '../tool-args';

/**
 * An analysis's save: what it changes, and which applied recommendations that
 * carries out — team edits for W- items, or a project's whole overlay for O-
 * items, one or the other per call.
 */
export const SaveTeamChangeArgsSchema = z.object({
  edits: editsField('the team as view="team" returned it')
    .optional()
    .describe('W- items: the changes to the shared team'),
  baseHash: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('W- items: the `hash` view="team" returned when you read it'),
  overlay: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "O- items: the project's WHOLE overlay document as it should stand",
    ),
  overlayProjectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "O- items: the project whose overlay this is (view=team's overlayNow.projectId)",
    ),
  overlayHash: z
    .string()
    .min(1)
    .max(64)
    .nullable()
    .optional()
    .describe(
      "O- items: view=team's overlayNow.hash; null when the project has none yet",
    ),
  ids: z
    .array(
      RecommendationIdSchema.regex(
        /^[WO]-/,
        'only W- items change the team and O- items its overlay',
      ),
    )
    .min(1)
    .max(MAX_RECOMMENDATIONS_PER_TARGET)
    .describe('The W-n or O-n ids this change carries out'),
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
  return readToolArgs(
    SaveTeamChangeArgsSchema.strict().superRefine((value, ctx) => {
      const overlay = value.overlay !== undefined;
      if (overlay === (value.edits !== undefined)) {
        ctx.addIssue({
          code: 'custom',
          message:
            'send `edits` (W- items) or `overlay` (O- items), one per call',
        });
      } else if (
        overlay &&
        (value.overlayProjectId === undefined ||
          value.overlayHash === undefined)
      ) {
        ctx.addIssue({
          code: 'custom',
          message:
            '`overlay` needs `overlayProjectId` and `overlayHash` (null when the project has none)',
        });
      } else if (!overlay && value.baseHash === undefined) {
        ctx.addIssue({ code: 'custom', message: '`edits` need `baseHash`' });
      }
    }),
    args,
  );
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
