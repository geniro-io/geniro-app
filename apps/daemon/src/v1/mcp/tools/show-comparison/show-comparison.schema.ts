import {
  MAX_COMPARISON_CRITERIA,
  MAX_COMPARISON_OPTIONS,
  SENTIMENTS,
} from '../../../agents/chat.types';

/** `show_comparison`'s arguments. */
export function showComparisonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What is being decided, as the card\'s heading — e.g. "Local store for the daemon". State the ' +
          'decision, not the word "Comparison".',
      },
      options: {
        type: 'array',
        description: `The options being compared, in the order they should appear — at least 2, at most ${MAX_COMPARISON_OPTIONS}.`,
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The option, as its column heading — e.g. "SQLite".',
            },
            note: {
              type: 'string',
              description:
                'One line under the heading where the name alone is not enough — a version, a flavour. Optional.',
            },
          },
          required: ['name'],
        },
      },
      criteria: {
        type: 'array',
        description: `What you are judging them on, one row each — at most ${MAX_COMPARISON_CRITERIA}. Pick the criteria that actually separate the options; a row where every answer is the same tells the reader nothing.`,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description: 'The criterion — e.g. "Setup cost", "Concurrency".',
            },
            cells: {
              type: 'array',
              description:
                'One entry per option, in the SAME order as `options`.',
              items: {
                type: 'object',
                properties: {
                  value: {
                    type: 'string',
                    description:
                      'What this option does about this criterion, in a few words — "none, it is a file", ' +
                      '"needs a server". Not a paragraph.',
                  },
                  verdict: {
                    type: 'string',
                    enum: [...SENTIMENTS],
                    description:
                      'How that reads FOR THIS OPTION — good, bad, or neither. This is the column-scanning ' +
                      'signal and the main reason to use this tool at all; omit it only where the answer ' +
                      'genuinely is not better or worse.',
                  },
                },
                required: ['value'],
              },
            },
          },
          required: ['label', 'cells'],
        },
      },
      recommendation: {
        type: 'object',
        description:
          'Which option you would take, and why. Omit ONLY when the honest answer is that it depends on ' +
          'something you do not know — and then say so in your reply.',
        properties: {
          option: {
            type: 'string',
            description:
              "The option's name, spelled exactly as in `options` so the card can mark that column.",
          },
          reason: {
            type: 'string',
            description:
              'One or two sentences on why, referring to what actually decides it for this user.',
          },
        },
        required: ['option', 'reason'],
      },
    },
    required: ['title', 'options', 'criteria'],
  };
}
