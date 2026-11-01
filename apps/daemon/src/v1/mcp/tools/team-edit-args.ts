import { z } from 'zod';

/** Edits per save or proposal — a change that needs more is a new team. */
const MAX_TEAM_EDITS = 50;

/** One edit — `TeamEdit` (`teams/utils/team-edits.ts`) says what each shape does. */
const TeamEditSchema = z.union([
  z
    .object({
      find: z
        .string()
        .min(1)
        .describe(
          'Exact text inside one string value of the team (a role, the instructions), occurring exactly once in the whole team',
        ),
      replace: z.string().describe('What replaces it'),
    })
    .strict(),
  z
    .object({
      path: z
        .string()
        .min(1)
        .describe('The field to delete, e.g. "members/reviewer/model"'),
      remove: z.literal(true),
    })
    .strict(),
  z
    .object({
      path: z
        .string()
        .min(1)
        .describe(
          'The field to set, "/"-separated; in a list a segment is an index, an element\'s id ("members/reviewer/model") or "-" to append ("instructionBlocks/-")',
        ),
      value: z.unknown().describe('The new value, any JSON'),
    })
    .strict(),
]);

/** The edits, described against the copy of the team the agent read. */
export function editsField(readCopy: string) {
  return z
    .array(TeamEditSchema)
    .min(1)
    .max(MAX_TEAM_EDITS)
    .describe(
      `The changes, applied in order to ${readCopy} — only what changes, never the whole team`,
    );
}
