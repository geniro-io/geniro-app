import { ArchiveThreadsSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `archive_threads`' arguments — generated from the schema they are parsed with. */
export function archiveThreadsSchema(): Record<string, unknown> {
  return toolInputSchema(ArchiveThreadsSchema);
}
