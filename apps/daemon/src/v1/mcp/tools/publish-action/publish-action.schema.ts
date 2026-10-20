import {
  ACTION_DESCRIPTION_MAX,
  ACTION_LABEL_MAX,
  ACTION_MESSAGE_MAX,
} from '../../../agents/chat.types';

/** `publish_action`'s arguments. */
export function publishActionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      label: {
        type: 'string',
        description: `The button's text, at most ${ACTION_LABEL_MAX} characters — e.g. "PR merged".`,
      },
      description: {
        type: 'string',
        description: `One line shown under the label and in its tooltip, at most ${ACTION_DESCRIPTION_MAX} characters. Optional.`,
      },
      action_id: {
        type: 'string',
        description:
          'Your id for the button, to replace or remove it later. Defaults to the label in lowercase with ' +
          'dashes ("PR merged" → "pr-merged").',
      },
      once: {
        type: 'boolean',
        description:
          'Whether a successful press retires the button. Default true; false keeps it for repeated presses.',
      },
      message: {
        type: 'string',
        description: `What a press sends into this chat, at most ${ACTION_MESSAGE_MAX} characters. Give this or \`stop\`.`,
      },
      stop: {
        type: 'object',
        description:
          'Makes a press stop a process this chat started, instead of sending a message. Give exactly one ' +
          'of `shell` or `pid`. Always one-shot.',
        properties: {
          shell: {
            type: 'string',
            description:
              'The id your shell tool gave a command it runs in the background.',
          },
          pid: {
            type: 'integer',
            description:
              'The pid of a process you started detached, e.g. the one `echo $!` printed.',
          },
        },
        additionalProperties: false,
      },
    },
    required: ['label'],
  };
}
