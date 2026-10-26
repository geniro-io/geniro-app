import {
  ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES,
  ACTION_COMMAND_TIMEOUT_MAX_MINUTES,
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
        description: `What a press sends into this chat, at most ${ACTION_MESSAGE_MAX} characters. Give this, \`stop\` or \`command\`.`,
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
      command: {
        type: 'object',
        description:
          'Makes a press run a command, after the user confirms a dialog showing it exactly. Runs without ' +
          'a shell: write a shell line as `["/bin/sh", "-c", "<line>"]`.',
        properties: {
          argv: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The program, then each argument, e.g. ["git", "status"]. No newlines or invisible characters.',
          },
          cwd: {
            type: 'string',
            description:
              "An absolute folder to run in. Defaults to this chat's folder.",
          },
          timeout_minutes: {
            type: 'integer',
            description: `Stopped after this many minutes, 1–${ACTION_COMMAND_TIMEOUT_MAX_MINUTES}. Default ${ACTION_COMMAND_TIMEOUT_DEFAULT_MINUTES}.`,
          },
          notify_agent: {
            type: 'boolean',
            description:
              "Whether the exit code and the end of its output are sent, when it finishes, where a press's " +
              "message would go — to you, or in a workflow to the agent the user's messages go to. Default false.",
          },
        },
        required: ['argv'],
        additionalProperties: false,
      },
    },
    required: ['label'],
  };
}
