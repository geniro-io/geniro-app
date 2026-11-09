import { toolInputSchema } from '../tool-args';
import {
  KnowledgeItemArgsSchema,
  KnowledgeSaveArgsSchema,
} from './knowledge-save.reader';

/** `knowledge_save`'s arguments — generated from the schema they are parsed with. */
export function knowledgeSaveSchema(): Record<string, unknown> {
  return toolInputSchema(KnowledgeSaveArgsSchema);
}

/** The one argument that carries out an applied item, as a listing shows it. */
export function knowledgeItemProperties(): Record<string, unknown> {
  return toolInputSchema(KnowledgeItemArgsSchema).properties as Record<
    string,
    unknown
  >;
}
