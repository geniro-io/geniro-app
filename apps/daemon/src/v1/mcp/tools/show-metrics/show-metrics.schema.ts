import { MAX_HOST_METRICS, SENTIMENTS } from '../../../agents/chat.types';

/** `show_metrics`'s arguments. */
export function showMetricsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the figures are about, as the card\'s heading — e.g. "After the caching change". Optional.',
      },
      metrics: {
        type: 'array',
        description: `The figures, in the order they should read — at most ${MAX_HOST_METRICS}, and fewer is better. Lead with the one that answers the question you were asked.`,
        items: {
          type: 'object',
          properties: {
            label: {
              type: 'string',
              description:
                'What this figure measures, as its caption — e.g. "Coverage", "Bundle size".',
            },
            value: {
              type: 'string',
              description:
                'The figure exactly as it should read, units included — "82%", "1.2 MB", "0". A string, ' +
                'never a bare number: you decide the formatting.',
            },
            delta: {
              type: 'string',
              description:
                'The change, also already formatted — "+4 pts", "−120 kB". Omit when there is nothing to ' +
                'compare against.',
            },
            sentiment: {
              type: 'string',
              enum: [...SENTIMENTS],
              description:
                'Whether that change is good news or bad. Say it — it cannot be read off the sign, since ' +
                '−40ms is good and −4 points of coverage is bad. Omit for a figure that is simply a fact.',
            },
            note: {
              type: 'string',
              description:
                'One line of context under the figure, where the number needs one. Optional.',
            },
          },
          required: ['label', 'value'],
        },
      },
    },
    required: ['metrics'],
  };
}
