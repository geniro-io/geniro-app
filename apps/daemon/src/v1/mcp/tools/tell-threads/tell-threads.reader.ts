import {
  type TellThreadsAnswer,
  type TellThreadsInput,
  TellThreadsSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `tell_threads` call's arguments, or why they cannot be read. */
export function readTellThreadsArgs(
  args: Record<string, unknown>,
): ToolArgs<TellThreadsInput> {
  return readToolArgs(TellThreadsSchema.strict(), args);
}

/** The answer as the manager reads it: the JSON, then what to do next. */
export function tellThreadsResultText(answer: TellThreadsAnswer): string {
  const said =
    answer.unresolved.length > 0
      ? 'Nothing was sent. Ask the user which threads they meant — the candidates are listed — then call again.'
      : 'Each thread above got the message. A reply reaches you as a message of your own; do not poll for it.';
  return `${JSON.stringify(answer)}\n${said}`;
}
