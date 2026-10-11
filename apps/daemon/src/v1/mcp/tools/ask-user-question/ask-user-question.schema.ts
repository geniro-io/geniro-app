import {
  MAX_HOST_QUESTION_OPTIONS,
  MAX_HOST_QUESTIONS,
} from '../../../agents/chat.types';

/** `ask_user_question`'s arguments. */
export function askUserQuestionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'Optional short heading for the whole card, when several questions belong to one decision.',
      },
      questions: {
        type: 'array',
        description: `The questions to ask — at most ${MAX_HOST_QUESTIONS}, each with its own options.`,
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description:
                'The question, written so it can be answered without reading your reasoning.',
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
                    description: 'The choice, in a few words.',
                  },
                  description: {
                    type: 'string',
                    description: 'What picking it means or leads to. Optional.',
                  },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    required: ['questions'],
  };
}
