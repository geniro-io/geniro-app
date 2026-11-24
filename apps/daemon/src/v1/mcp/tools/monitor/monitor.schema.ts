import {
  MONITOR_COMMAND_MAX,
  MONITOR_DESCRIPTION_MAX,
  MONITOR_TIMEOUT_DEFAULT_MS,
  MONITOR_TIMEOUT_MAX_MS,
  MONITOR_TIMEOUT_MIN_MS,
} from '../../../agents/chat.types';

/** `monitor`'s arguments. */
export function monitorSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: `The shell command line to run, at most ${MONITOR_COMMAND_MAX} characters — pipes and redirects work.`,
      },
      description: {
        type: 'string',
        description: `What it watches, e.g. "CI run 4812". A longer one is cut to its first ${MONITOR_DESCRIPTION_MAX} characters.`,
      },
      timeout_ms: {
        type: 'integer',
        minimum: MONITOR_TIMEOUT_MIN_MS,
        maximum: MONITOR_TIMEOUT_MAX_MS,
        default: MONITOR_TIMEOUT_DEFAULT_MS,
        description:
          'Milliseconds after which the command is stopped as timed out.',
      },
    },
    required: ['command', 'description'],
  };
}
