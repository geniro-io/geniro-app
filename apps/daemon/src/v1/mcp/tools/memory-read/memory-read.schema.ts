import { toolInputSchema } from '../tool-args';
import { MemoryReadArgsSchema } from './memory-read.reader';

/** `memory_read`'s arguments — generated from the schema they are parsed with. */
export function memoryReadSchema(): Record<string, unknown> {
  return toolInputSchema(MemoryReadArgsSchema);
}
