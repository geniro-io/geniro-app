import { toolInputSchema } from '../tool-args';
import { MemorySaveArgsSchema } from './memory-save.reader';

/** `memory_save`'s arguments — generated from the schema they are parsed with. */
export function memorySaveSchema(): Record<string, unknown> {
  return toolInputSchema(MemorySaveArgsSchema);
}
