import { toolInputSchema } from '../tool-args';
import { KnowledgeSaveArgsSchema } from './knowledge-save.reader';

/** `knowledge_save`'s arguments — generated from the schema they are parsed with. */
export function knowledgeSaveSchema(): Record<string, unknown> {
  return toolInputSchema(KnowledgeSaveArgsSchema);
}
