import { MAX_NOTIFY_MESSAGE_LENGTH } from '../../../agents/chat.types';

/** `notify_user`'s arguments. */
export function notifyUserSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: `One sentence, at most ${MAX_NOTIFY_MESSAGE_LENGTH} characters: what is ready, and where.`,
      },
    },
    required: ['message'],
  };
}
