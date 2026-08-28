import { writeFile } from 'node:fs/promises';

import { dialog } from 'electron';

import type { ChatExportSaveResult } from '../shared/contracts';

/**
 * Ask the user where to keep a chat export, and write it there.
 *
 * ONE channel doing both halves, unlike the workflow export beside it
 * (`pickWorkflowExport` → the DAEMON writes the path it was handed). The
 * difference is who holds the bytes: a workflow lives in the daemon's library,
 * so the renderer has only a slug to pass along, while a chat export is a
 * document the renderer already fetched and holds in full. Handing that path
 * back down for a second process to re-derive the same document would be a
 * second read of a long transcript, and a window in which the two could differ.
 *
 * A CANCEL is not a failure — `saved: false` with no path, and the caller says
 * nothing. It is the commonest outcome of opening a save dialog.
 */
export async function saveChatExport(input: {
  suggestedName: string;
  content: string;
}): Promise<ChatExportSaveResult> {
  const result = await dialog.showSaveDialog({
    defaultPath: input.suggestedName,
    filters: [{ name: 'Geniro chat export', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) {
    return { saved: false, path: null };
  }
  await writeFile(result.filePath, input.content, 'utf8');
  return { saved: true, path: result.filePath };
}
