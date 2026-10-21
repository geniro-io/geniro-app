/** `stop_monitor`'s arguments. */
export function stopMonitorSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The id monitor reported, e.g. "m1".',
      },
    },
    required: ['id'],
  };
}
