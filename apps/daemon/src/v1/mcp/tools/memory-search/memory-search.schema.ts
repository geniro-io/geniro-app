import { toolInputSchema } from '../tool-args';
import { MemorySearchArgsSchema } from './memory-search.reader';

/** `memory_search`'s arguments — generated from the schema they are parsed with. */
export function memorySearchSchema(): Record<string, unknown> {
  return toolInputSchema(MemorySearchArgsSchema);
}
