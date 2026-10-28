import { toolInputSchema } from '../tool-args';
import { MemoryForgetArgsSchema } from './memory-forget.reader';

/** `memory_forget`'s arguments — generated from the schema they are parsed with. */
export function memoryForgetSchema(): Record<string, unknown> {
  return toolInputSchema(MemoryForgetArgsSchema);
}
