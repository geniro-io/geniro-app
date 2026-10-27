import { RunOutcomeAcceptanceSchema } from '../../../agents/chat.types';
import { OUTCOME_SUMMARY_MAX } from './record-outcome.reader';

/** `record_outcome`'s arguments. */
export function recordOutcomeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
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
        maxLength: OUTCOME_SUMMARY_MAX,
        description:
          'Optional. One to three sentences a person reads on the outcome: what the change does, what the user asked to change, or what is still open before acceptance.',
      },
    },
    required: ['pr_number', 'pr_url', 'draft', 'review_rounds', 'acceptance'],
  };
}
