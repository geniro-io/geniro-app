import {
  RunOutcomeAcceptanceSchema,
  THREAD_OUTCOME_SUMMARY_MAX,
  ThreadOutcomeKindSchema,
} from '../../../agents/chat.types';
import { OUTCOME_SUMMARY_MAX } from './record-outcome.reader';

/** `record_outcome`'s arguments. */
export function recordOutcomeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: [...ThreadOutcomeKindSchema.options],
        description:
          'How the whole thread ended: success, partial, failed or abandoned. Send it with `summary` alone, never with the pull request fields.',
      },
      pr_number: {
        type: 'integer',
        minimum: 1,
        description: 'The pull request number.',
      },
      pr_url: {
        type: 'string',
        description:
          "The pull request's github.com URL (https://github.com/<owner>/<repo>/pull/<number>); it must name the same number.",
      },
      draft: {
        type: 'boolean',
        description: 'Whether the pull request is still a draft.',
      },
      review_rounds: {
        type: 'integer',
        minimum: 0,
        description:
          'Reviews of this pull request run after it was built — full or light.',
      },
      acceptance: {
        type: 'string',
        enum: [...RunOutcomeAcceptanceSchema.options],
        description:
          "The user's verdict on the change: accepted, changes_requested, not_yet, or not_needed.",
      },
      summary: {
        type: 'string',
        maxLength: Math.max(OUTCOME_SUMMARY_MAX, THREAD_OUTCOME_SUMMARY_MAX),
        description:
          'One to three sentences a person reads on the outcome. Required with `outcome`: what was done and what is left. Optional for a pull request: what the change does, what the user asked to change, or what is still open before acceptance.',
      },
    },
  };
}
