import { writeFile } from 'node:fs/promises';

import { dialog, type FileFilter } from 'electron';

import type { FileSaveResult } from '../shared/contracts';

const MEMORY_EXPORT_FORMATS: FileFilter[] = [
  { name: 'Markdown', extensions: ['md'] },
];

function localDate(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * Ask the user where to keep the shared-memory export, and write the Markdown
 * the renderer fetched from the daemon there. Main composes the suggested name
 * so the renderer sends no text that reaches the dialog's path. A cancel is an
 * outcome (`saved: false`), not a failure.
 */
export async function saveMemoryExport(
  markdown: string,
): Promise<FileSaveResult> {
  const result = await dialog.showSaveDialog({
    defaultPath: `geniro-memory-${localDate(new Date())}.${MEMORY_EXPORT_FORMATS[0]!.extensions[0]!}`,
    filters: MEMORY_EXPORT_FORMATS,
  });
  if (result.canceled || !result.filePath) {
    return { saved: false, path: null };
  }
  await writeFile(result.filePath, markdown, 'utf8');
  return { saved: true, path: result.filePath };
}
