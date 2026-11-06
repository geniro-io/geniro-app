import {
  type ThreadMessageAnswer,
  type ThreadMessageSend,
  ThreadMessageSendSchema,
} from '../../../agents/chat.types';
import { threadMessageReasonWords } from '../../../agents/utils/thread-message-text';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `message_thread` call's arguments, or why they cannot be read. */
export function readMessageThreadArgs(
  args: Record<string, unknown>,
): ToolArgs<ThreadMessageSend> {
  return readToolArgs(ThreadMessageSendSchema.strict(), args);
}

/** The answer as the sender reads it: the JSON, then what it means. */
export function messageThreadResultText(answer: ThreadMessageAnswer): string {
  const said =
    answer.reason === undefined
      ? 'Do not wait for a reply: if that thread answers, it reaches you as a message of your own.'
      : `It ${threadMessageReasonWords(answer.reason)}.`;
  return `${JSON.stringify(answer)}\n${said}`;
}
