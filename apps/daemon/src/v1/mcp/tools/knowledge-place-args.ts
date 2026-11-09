import { z } from 'zod';

import { KNOWLEDGE_PLACE_NAME_MAX_CHARS } from '../../knowledge/knowledge.types';
import type { ToolArgs } from '../mcp.types';
import { readToolArgs, toolInputSchema } from './tool-args';

/** Another place a knowledge call acts in, instead of the run's own. */
const NamedPlaceSchema = z.object({
  project: z
    .string()
    .trim()
    .min(1)
    .max(KNOWLEDGE_PLACE_NAME_MAX_CHARS)
    .optional()
    .describe(
      "Act in another project: its `id`, as list_projects names it. Leave it out for this chat's own places.",
    ),
  team: z
    .string()
    .trim()
    .min(1)
    .max(KNOWLEDGE_PLACE_NAME_MAX_CHARS)
    .optional()
    .describe(
      "Act in a team's knowledge: its slug, as read_teams names it. Leave it out for this chat's own places.",
    ),
});

/** The two arguments as a listing shows them. */
export function knowledgePlaceProperties(): Record<string, unknown> {
  return toolInputSchema(NamedPlaceSchema).properties as Record<
    string,
    unknown
  >;
}

export interface KnowledgePlaceArgs {
  /** The place named, or null when the call names none. */
  named: { projectId: string | null; teamSlug: string | null } | null;
  /** The call's other arguments, for the tool's own reader. */
  rest: Record<string, unknown>;
}

/** Takes `project` and `team` out of a call's arguments. Never throws. */
export function readKnowledgePlaceArgs(
  args: Record<string, unknown>,
): ToolArgs<KnowledgePlaceArgs> {
  const { project, team, ...rest } = args;
  const read = readToolArgs(NamedPlaceSchema, { project, team });
  if (!read.ok) {
    return read;
  }
  const projectId = read.query.project ?? null;
  const teamSlug = read.query.team ?? null;
  return {
    ok: true,
    query: {
      named:
        projectId === null && teamSlug === null
          ? null
          : { projectId, teamSlug },
      rest,
    },
  };
}
