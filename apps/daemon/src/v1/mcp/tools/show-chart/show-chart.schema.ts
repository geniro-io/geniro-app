import {
  CHART_KINDS,
  MAX_CHART_POINTS,
  MAX_CHART_SERIES,
} from '../../../agents/chat.types';

/** `show_chart`'s arguments. */
export function showChartSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the chart shows, as the card\'s heading — e.g. "Test suite duration by commit".',
      },
      kind: {
        type: 'string',
        enum: [...CHART_KINDS],
        description:
          'line for a trend over an ordered axis, bar to compare separate categories, area for a total ' +
          'made of stacked parts.',
      },
      x_label: {
        type: 'string',
        description: 'Caption for the x axis. Optional.',
      },
      y_label: {
        type: 'string',
        description:
          'Caption for the y axis, naming the UNIT — "seconds", "kB", "%". Optional but rarely worth ' +
          'omitting: a number with no unit is not a measurement.',
      },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: `The x-axis categories, in the order they should be plotted — at most ${MAX_CHART_POINTS}.`,
      },
      series: {
        type: 'array',
        description: `The plotted series — at most ${MAX_CHART_SERIES}, because that is how many colours the legend can tell apart.`,
        items: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description:
                'What this series is, as its legend entry — e.g. "unit", "integration".',
            },
            values: {
              type: 'array',
              items: { type: ['number', 'null'] },
              description:
                'One number per entry of `labels`, in the same order. Null for a point you did not measure.',
            },
          },
          required: ['name', 'values'],
        },
      },
    },
    required: ['title', 'kind', 'labels', 'series'],
  };
}
