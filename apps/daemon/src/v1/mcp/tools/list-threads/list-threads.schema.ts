import { ThreadListQuerySchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `list_threads`'s arguments — generated from the schema they are parsed with. */
export function listThreadsSchema(): Record<string, unknown> {
  return toolInputSchema(ThreadListQuerySchema);
}
