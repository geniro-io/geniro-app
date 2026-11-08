import { toolInputSchema } from '../tool-args';
import { KnowledgeReadArgsSchema } from './knowledge-read.reader';

/** `knowledge_read`'s arguments — generated from the schema they are parsed with. */
export function knowledgeReadSchema(): Record<string, unknown> {
  return toolInputSchema(KnowledgeReadArgsSchema);
}
