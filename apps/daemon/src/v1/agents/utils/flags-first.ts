import { HOST_FLAG_ISSUE_TOOL } from '../chat.types';

const WHERE_THE_FLAGS_ARE = {
  thread: 'view=overview opens with them, under `flags`',
  runs: "view=runs counts each run's `flags`, and view=overview runId=… opens with that run's",
  period:
    "view=digest opens with the period's flags, and view=overview runId=… with each thread's",
} as const;

/**
 * The section every analysis guide opens its method with: the flags the
 * analysed threads' own agents recorded are read before anything else.
 */
export function flagsFirstSection(
  where: keyof typeof WHERE_THE_FLAGS_ARE,
): string {
  return `## Read the flags first

The agents of the threads you read record what went wrong themselves, with \`${HOST_FLAG_ISSUE_TOOL}\`: a problem that cost real work, or the user's disagreement — each with its seq, cost, category and summary. ${WHERE_THE_FLAGS_ARE[where]}. Read them before anything else and start from the moments they name. A flag is still a claim: check it against the rows around its seq, and never take a thread with no flag for a thread with no problem.`;
}
