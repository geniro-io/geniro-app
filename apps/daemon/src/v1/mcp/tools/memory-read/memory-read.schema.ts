import { withSynonymProperties } from '../../../../utils/tool-arg-synonyms';
import { toolInputSchema } from '../tool-args';
import {
  MEMORY_READ_SYNONYMS,
  MemoryReadArgsSchema,
} from './memory-read.reader';

/** `memory_read`'s arguments — generated from the schema they are parsed with. */
export function memoryReadSchema(): Record<string, unknown> {
  return withSynonymProperties(
    toolInputSchema(MemoryReadArgsSchema),
    MEMORY_READ_SYNONYMS,
  );
}
