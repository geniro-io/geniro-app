import { toolInputSchema } from '../tool-args';
import { GoalsArgsSchema } from './goals.reader';

/** `goals`' arguments, generated from the schema the reader holds them to. */
export function goalsSchema(): Record<string, unknown> {
  return toolInputSchema(
    GoalsArgsSchema.extend({
      action: GoalsArgsSchema.shape.action.describe(
        'list: read the goals. set: replace the open goals with `goals`. add: append `goals`. update: reword goal `id` to `text`. remove: take open goal `id` off the list. complete: close goal `id` with `status` and `evidence`. reopen: put closed goal `id` back to open, its evidence gone, to `complete` it again.',
      ),
      goals: GoalsArgsSchema.shape.goals.describe(
        'For set and add. Each goal is one checkable outcome; `source` is user when the user asked for it in so many words, agent when you inferred it.',
      ),
      id: GoalsArgsSchema.shape.id.describe(
        'The goal (g1, g2, …) for update, remove, complete and reopen.',
      ),
      text: GoalsArgsSchema.shape.text.describe(
        "For update: the goal's new wording.",
      ),
      status: GoalsArgsSchema.shape.status.describe(
        'For complete: achieved, not_achieved, or dropped (no longer wanted).',
      ),
      evidence: GoalsArgsSchema.shape.evidence.describe(
        'For complete, required for every status: what shows how the goal ended — a test run and its result, a command, a link, a file, or why it was dropped.',
      ),
    }),
  );
}
