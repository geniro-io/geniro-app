import { ReadAnalyzedThreadArgsSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `read_analyzed_thread`'s arguments — generated from the schema they are parsed with. */
export function readAnalyzedThreadSchema(): Record<string, unknown> {
  return toolInputSchema(ReadAnalyzedThreadArgsSchema);
}
