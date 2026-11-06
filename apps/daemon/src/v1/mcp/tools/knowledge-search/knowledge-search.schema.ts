import { toolInputSchema } from '../tool-args';
import { KnowledgeSearchArgsSchema } from './knowledge-search.reader';

/** `knowledge_search`'s arguments — generated from the schema they are parsed with. */
export function knowledgeSearchSchema(): Record<string, unknown> {
  return toolInputSchema(KnowledgeSearchArgsSchema);
}
