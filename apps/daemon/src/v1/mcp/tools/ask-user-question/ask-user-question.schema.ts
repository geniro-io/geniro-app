import { MAX_QUESTION_ATTACHMENTS } from '../../../agents/utils/question-attachments';
import { MAX_QUESTION_ARTIFACT_ID_LENGTH } from './ask-user-question.reader';
import {
  MAX_HOST_QUESTION_OPTIONS,
  MAX_HOST_QUESTIONS,
} from '../../../agents/chat.types';
import {
  MAX_HOST_OPTION_DESCRIPTION_LENGTH,
  MAX_HOST_OPTION_LABEL_LENGTH,
  MAX_HOST_QUESTION_TEXT_LENGTH,
  MAX_HOST_QUESTION_TITLE_LENGTH,
} from '../../../agents/utils/host-question';

/** `ask_user_question`'s arguments. */
export function askUserQuestionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `Optional short heading for the whole card, when several questions belong to one decision. At most ${MAX_HOST_QUESTION_TITLE_LENGTH} characters; a longer one is refused.`,
      },
      questions: {
        type: 'array',
        description: `The questions to ask — at most ${MAX_HOST_QUESTIONS}, each with its own options.`,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: `The question, written so it can be answered without reading your reasoning. At most ${MAX_HOST_QUESTION_TEXT_LENGTH} characters; a longer one is refused.`,
            },
            header: {
              type: 'string',
              description:
                'A 1-3 word label for this question, used as its tab title.',
            },
            multiSelect: {
              type: 'boolean',
              description:
                'True when more than one option may be picked. Defaults to false.',
            },
            options: {
              type: 'array',
              description: `The choices, at most ${MAX_HOST_QUESTION_OPTIONS}. Offer real alternatives; the user can always answer in their own words instead.`,
              items: {
                type: 'object',
                properties: {
                  label: {
                    type: 'string',
                    description: `The choice, in a few words. At most ${MAX_HOST_OPTION_LABEL_LENGTH} characters; a longer one is refused.`,
                  },
                  description: {
                    type: 'string',
                    description: `What picking it means or leads to. Optional. At most ${MAX_HOST_OPTION_DESCRIPTION_LENGTH} characters; a longer one is refused.`,
                  },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
      artifacts: {
        type: 'array',
        description: `Optional: the ids of pages you published with show_artifact in this thread that the question is about — at most ${MAX_QUESTION_ATTACHMENTS}. The card shows them beside the question. An id this thread never published refuses the call.`,
        items: { type: 'string', maxLength: MAX_QUESTION_ARTIFACT_ID_LENGTH },
        maxItems: MAX_QUESTION_ATTACHMENTS,
      },
    },
    required: ['questions'],
  };
}
