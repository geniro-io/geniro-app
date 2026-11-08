import type { FileSaveResult } from '../shared/contracts';
import type { KnowledgeExportSave } from './ipc-schemas';
import { saveMarkdown } from './save-memory-export';

/** The memory export's dialog, under the file name the daemon composed. */
export function saveKnowledgeExport({
  markdown,
  suggestedName,
}: KnowledgeExportSave): Promise<FileSaveResult> {
  return saveMarkdown(suggestedName, markdown);
}
