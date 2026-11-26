import { withSynonymProperties } from '../../../../utils/tool-arg-synonyms';
import { toolInputSchema } from '../tool-args';
import {
  MEMORY_SEARCH_SYNONYMS,
  MemorySearchArgsSchema,
} from './memory-search.reader';

/** `memory_search`'s arguments — generated from the schema they are parsed with. */
export function memorySearchSchema(): Record<string, unknown> {
  return withSynonymProperties(
    toolInputSchema(MemorySearchArgsSchema),
    MEMORY_SEARCH_SYNONYMS,
  );
}
